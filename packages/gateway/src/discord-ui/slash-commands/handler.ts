import type { ChatInputCommandInteraction, MessageCreateOptions } from "discord.js";
import type Redis from "ioredis";
import { compactSession, newSession, reloadSession } from "../../command-queue";
import { ALLOWED_MODELS, ALLOWED_THINKING_LEVELS, loadGatewayConfig, saveGatewayConfig } from "../../commands/config";
import type { EnqueueFn } from "../../channels/redis";
import { injectChannelContext } from "../../formatting";
import { enrichPromptWithVaultContext } from "../../vault-read";
import { renderApprovalCard } from "../components/approval-card";
import { renderRunCard } from "../components/run-card";
import { renderSearchResultCard, type SearchResultItem } from "../components/search-result-card";
import { renderSessionCard } from "../components/session-card";
import { renderStatusContainer } from "../components/status-container";
import { stripAnsi } from "../helpers/format";
import { truncate } from "../helpers/truncate";

export type DiscordSlashHandlerDeps = {
  enqueue: EnqueueFn;
  redis?: Redis;
  abortCurrentTurn?: () => Promise<void>;
};

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runJoelclawCommand(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: ["joelclaw", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdoutRaw, stderrRaw] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);

  return {
    exitCode,
    stdout: stripAnsi(stdoutRaw).trim(),
    stderr: stripAnsi(stderrRaw).trim(),
  };
}

function parseKeyValues(output: string): Array<{ key: string; value: string }> {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/^[\s│├└─]+/, "").trim())
    .filter(Boolean);

  const rows: Array<{ key: string; value: string }> = [];

  for (const line of lines) {
    const direct = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (direct?.[1] && direct[2]) {
      rows.push({ key: direct[1].trim(), value: direct[2].trim() });
      continue;
    }

    const pair = line.match(/^([^\s]{2,20})\s{2,}(.+)$/);
    if (pair?.[1] && pair[2]) {
      rows.push({ key: pair[1].trim(), value: pair[2].trim() });
    }
  }

  return rows.slice(0, 10);
}

function classifyStatus(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("fail") || lower.includes("error") || lower.includes("fatal")) return "error";
  if (lower.includes("slow") || lower.includes("warn") || lower.includes("degraded")) return "warning";
  if (lower.includes("ok") || lower.includes("success") || lower.includes("completed")) return "success";
  return "unknown";
}

function parseRuns(output: string, fallbackCount = 5): Array<{ status: string; name: string; age: string; duration?: string }> {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^joelclaw\b/i.test(line))
    .filter((line) => !/^runs?\b/i.test(line));

  const parsed = lines.slice(0, fallbackCount).map((line) => {
    const tokens = line.split(/\s+/).filter(Boolean);
    const name = tokens.slice(0, 3).join(" ") || line;
    const duration = tokens.find((token) => /\d+(ms|s|m|h)$/i.test(token));
    return {
      status: classifyStatus(line),
      name: truncate(name, 40),
      age: "recent",
      duration,
    };
  });

  return parsed;
}

function parseSearchResults(output: string): SearchResultItem[] {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^joelclaw\b/i.test(line));

  const results: SearchResultItem[] = [];

  for (const line of lines) {
    const scoreMatch = line.match(/\[?(0(?:\.\d+)?|1(?:\.0+)?)\]?\s+(.+)/);
    if (scoreMatch?.[1] && scoreMatch[2]) {
      const score = Number.parseFloat(scoreMatch[1]);
      const text = scoreMatch[2].trim();
      const [title, ...rest] = text.split(/[—-]/);
      results.push({
        score: Number.isFinite(score) ? score : 0,
        title: truncate((title ?? text).trim(), 110),
        context: truncate(rest.join("-").trim() || text, 180),
      });
      continue;
    }

    results.push({
      score: 0.5,
      title: truncate(line, 110),
      context: truncate(line, 180),
    });
  }

  return results.slice(0, 6);
}

function failedCommandCard(title: string, result: CliResult): MessageCreateOptions {
  return renderStatusContainer({
    title,
    level: "error",
    subtitle: "Command execution failed",
    metrics: [
      { key: "Exit", value: String(result.exitCode) },
      { key: "Error", value: truncate(result.stderr || "(no stderr)", 220) },
    ],
    notes: result.stdout ? [truncate(result.stdout, 220)] : undefined,
  });
}

async function handleStatusCommand(args: string[], title: string): Promise<MessageCreateOptions> {
  const result = await runJoelclawCommand(args);
  if (result.exitCode !== 0) {
    return failedCommandCard(title, result);
  }

  const metrics = parseKeyValues(result.stdout);
  return renderStatusContainer({
    title,
    level: "healthy",
    subtitle: truncate(result.stdout.split("\n")[0] ?? "", 220),
    metrics: metrics.length > 0
      ? metrics
      : [{ key: "Output", value: truncate(result.stdout || "(no output)", 220) }],
    notes: result.stdout
      ? result.stdout.split("\n").slice(1, 4).map((line) => truncate(line, 180)).filter(Boolean)
      : undefined,
  });
}

export async function handleDiscordSlashCommand(
  interaction: ChatInputCommandInteraction,
  deps: DiscordSlashHandlerDeps,
): Promise<MessageCreateOptions> {
  const name = interaction.commandName;

  if (name === "status") {
    return handleStatusCommand(["status"], "System Status");
  }

  if (name === "health") {
    return handleStatusCommand(["gateway", "status"], "Gateway Health");
  }

  if (name === "runs") {
    const count = interaction.options.getInteger("count") ?? 5;
    const result = await runJoelclawCommand(["runs", "--count", String(count)]);
    if (result.exitCode !== 0) {
      return failedCommandCard("Recent Runs", result);
    }

    return renderRunCard({
      title: `Recent Runs (${count})`,
      runs: parseRuns(result.stdout, count),
    });
  }

  if (name === "search" || name === "recall") {
    const query = interaction.options.getString("query", true).trim();
    const command = name === "recall" ? "recall" : "search";
    const result = await runJoelclawCommand([command, query]);
    if (result.exitCode !== 0) {
      return failedCommandCard(`${command} ${query}`, result);
    }

    return renderSearchResultCard({
      query,
      source: name === "recall" ? "recall" : "search",
      results: parseSearchResults(result.stdout),
    });
  }

  if (name === "model") {
    const model = interaction.options.getString("model", true).trim();
    if (!ALLOWED_MODELS.includes(model as (typeof ALLOWED_MODELS)[number])) {
      return renderStatusContainer({
        title: "Invalid model",
        level: "error",
        metrics: [{ key: "Allowed", value: ALLOWED_MODELS.join(", ") }],
      });
    }

    if (!deps.redis) {
      return renderStatusContainer({
        title: "Model not updated",
        level: "warning",
        metrics: [{ key: "Reason", value: "Redis unavailable" }],
      });
    }

    const config = await loadGatewayConfig(deps.redis);
    await saveGatewayConfig(deps.redis, { ...config, model: model as (typeof ALLOWED_MODELS)[number] });

    return renderStatusContainer({
      title: "Model configured",
      level: "info",
      metrics: [
        { key: "Model", value: model },
        { key: "Apply", value: "On next gateway restart" },
      ],
    });
  }

  if (name === "thinking") {
    const level = interaction.options.getString("level", true).trim().toLowerCase();
    if (!ALLOWED_THINKING_LEVELS.includes(level as (typeof ALLOWED_THINKING_LEVELS)[number])) {
      return renderStatusContainer({
        title: "Invalid thinking level",
        level: "error",
        metrics: [{ key: "Allowed", value: ALLOWED_THINKING_LEVELS.join(", ") }],
      });
    }

    if (!deps.redis) {
      return renderStatusContainer({
        title: "Thinking not updated",
        level: "warning",
        metrics: [{ key: "Reason", value: "Redis unavailable" }],
      });
    }

    const config = await loadGatewayConfig(deps.redis);
    await saveGatewayConfig(deps.redis, {
      ...config,
      thinkingLevel: level as (typeof ALLOWED_THINKING_LEVELS)[number],
    });

    return renderStatusContainer({
      title: "Thinking configured",
      level: "info",
      metrics: [
        { key: "Level", value: level },
        { key: "Apply", value: "On next gateway restart" },
      ],
    });
  }

  if (name === "compact") {
    await compactSession();
    return renderSessionCard({
      status: "active",
      details: "Session context compacted.",
      actions: [{ id: "session:ok", label: "Done", style: "success" }],
    });
  }

  if (name === "new") {
    await newSession();
    return renderSessionCard({
      status: "active",
      details: "Started a new gateway session.",
      actions: [{ id: "session:new", label: "Started", style: "success" }],
    });
  }

  if (name === "reload") {
    await reloadSession();
    return renderSessionCard({
      status: "active",
      details: "Reloaded extensions, skills, and prompts.",
      actions: [{ id: "session:reloaded", label: "Reloaded", style: "success" }],
    });
  }

  if (name === "queue") {
    const prompt = interaction.options.getString("prompt", true).trim();
    const source = `discord:${interaction.channelId}`;
    const withContext = injectChannelContext(prompt, {
      source,
      threadName: interaction.channel?.isThread() ? interaction.channel.name : undefined,
    });
    const enriched = await enrichPromptWithVaultContext(withContext);

    await deps.enqueue(source, enriched, {
      source,
      discordChannelId: interaction.channelId,
      discordGuildId: interaction.guildId,
      discordAuthorId: interaction.user.id,
      command: "queue",
    });

    return renderSessionCard({
      status: "pending",
      details: `Queued follow-up prompt: ${truncate(prompt, 120)}`,
      actions: [{ id: "queue:queued", label: "Queued", style: "success" }],
    });
  }

  if (name === "abort") {
    if (!deps.abortCurrentTurn) {
      return renderStatusContainer({
        title: "Abort unavailable",
        level: "warning",
        metrics: [{ key: "Reason", value: "Abort callback not configured" }],
      });
    }

    await deps.abortCurrentTurn();
    return renderApprovalCard({
      state: "approved",
      targetPath: "gateway-session",
      change: "Abort signal sent to current operation.",
      risk: "Low",
      actions: [{ id: "abort:ok", label: "Acknowledged", style: "success" }],
    });
  }

  if (name === "fork") {
    const messageId = interaction.options.getString("message_id")?.trim();
    return renderSessionCard({
      status: "pending",
      details: messageId
        ? `Fork requested from message ${messageId}. Thread forking lands with ADR-0124 implementation.`
        : "Fork requested. Thread forking lands with ADR-0124 implementation.",
      actions: [{ id: "session:fork:pending", label: "Pending", style: "secondary" }],
    });
  }

  if (name === "resume") {
    const target = interaction.options.getString("session")?.trim();
    return renderSessionCard({
      status: "pending",
      details: target
        ? `Resume requested for session ${target}.`
        : "Resume requested for the previous session.",
      actions: [{ id: "session:resume:pending", label: "Pending", style: "secondary" }],
    });
  }

  return renderStatusContainer({
    title: `Unknown command: ${name}`,
    level: "warning",
    metrics: [{ key: "Command", value: name }],
  });
}
