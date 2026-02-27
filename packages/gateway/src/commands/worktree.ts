import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import type { InlineButton } from "../channels/telegram";
import {
  type CommandDefinition,
  defineChatCommand,
} from "./registry";

const MONOREPO_ROOT = path.resolve(os.homedir(), "Code/joelhooks/joelclaw");
const WORKTREE_ROOT = "/tmp/joelclaw-worktrees";
const WORKTREE_CALLBACK_PREFIX = "worktree:";
const MAX_DIFF_CHARS = 3500;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, maxChars = MAX_DIFF_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function normalizeTaskId(taskId: string): string {
  const normalized = taskId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const shortened = normalized.slice(0, 40);

  if (!shortened) {
    throw new Error("Task id is required");
  }

  return shortened;
}

function branchName(taskId: string): string {
  return `codex/${normalizeTaskId(taskId)}`;
}

function worktreePath(taskId: string): string {
  return path.join(WORKTREE_ROOT, normalizeTaskId(taskId));
}

async function runGit(args: string[], cwd = MONOREPO_ROOT): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdoutRaw, stderrRaw] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);

  const stdout = stdoutRaw.trim();
  const stderr = stderrRaw.trim();

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout || "unknown error"}`);
  }

  return { stdout, stderr };
}

export async function createWorktree(taskId: string): Promise<{ worktreePath: string; branch: string }> {
  const normalized = normalizeTaskId(taskId);
  const branch = branchName(normalized);
  const targetPath = worktreePath(normalized);

  try {
    await mkdir(WORKTREE_ROOT, { recursive: true });
    await runGit(["worktree", "add", targetPath, "-b", branch, "main"], MONOREPO_ROOT);
    return { worktreePath: targetPath, branch };
  } catch (error) {
    console.error("[gateway:worktree] createWorktree failed", {
      taskId: normalized,
      error: String(error),
    });
    throw error;
  }
}

export async function getWorktreeDiff(taskId: string): Promise<string> {
  const normalized = normalizeTaskId(taskId);

  try {
    const { stdout } = await runGit(["diff", "main"], worktreePath(normalized));
    return stdout;
  } catch (error) {
    console.error("[gateway:worktree] getWorktreeDiff failed", {
      taskId: normalized,
      error: String(error),
    });
    throw error;
  }
}

export async function mergeWorktree(taskId: string): Promise<{ success: boolean; message: string }> {
  const normalized = normalizeTaskId(taskId);
  const branch = branchName(normalized);

  try {
    await runGit(["checkout", "main"], MONOREPO_ROOT);
    await runGit(["merge", branch], MONOREPO_ROOT);

    let cleanupWarning = "";
    try {
      await discardWorktree(normalized);
    } catch (error) {
      cleanupWarning = ` (cleanup warning: ${String(error)})`;
      console.warn("[gateway:worktree] cleanup after merge failed", {
        taskId: normalized,
        error: String(error),
      });
    }

    return {
      success: true,
      message: `Merged ${branch} into main${cleanupWarning}`,
    };
  } catch (error) {
    console.error("[gateway:worktree] mergeWorktree failed", {
      taskId: normalized,
      error: String(error),
    });
    return {
      success: false,
      message: `Merge failed for ${branch}: ${String(error)}`,
    };
  }
}

export async function discardWorktree(taskId: string): Promise<void> {
  const normalized = normalizeTaskId(taskId);
  const branch = branchName(normalized);
  const targetPath = worktreePath(normalized);

  try {
    await runGit(["worktree", "remove", targetPath, "--force"], MONOREPO_ROOT);
  } catch (error) {
    console.error("[gateway:worktree] worktree remove failed", {
      taskId: normalized,
      error: String(error),
    });
    throw error;
  }

  try {
    await runGit(["branch", "-d", branch], MONOREPO_ROOT);
  } catch (deleteError) {
    console.warn("[gateway:worktree] branch -d failed, trying -D", {
      taskId: normalized,
      error: String(deleteError),
    });
    await runGit(["branch", "-D", branch], MONOREPO_ROOT);
  }
}

export async function listWorktrees(): Promise<Array<{ taskId: string; branch: string; path: string }>> {
  try {
    const { stdout } = await runGit(["worktree", "list", "--porcelain"], MONOREPO_ROOT);
    const blocks = stdout.split(/\n\n+/g);
    const result: Array<{ taskId: string; branch: string; path: string }> = [];

    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const worktreeLine = lines.find((line) => line.startsWith("worktree "));
      const branchLine = lines.find((line) => line.startsWith("branch "));
      if (!worktreeLine || !branchLine) continue;

      const fullBranch = branchLine.slice("branch ".length).trim();
      const branchPrefix = "refs/heads/codex/";
      if (!fullBranch.startsWith(branchPrefix)) continue;

      const taskId = fullBranch.slice(branchPrefix.length);
      const branch = `codex/${taskId}`;
      const absolutePath = worktreeLine.slice("worktree ".length).trim();

      result.push({
        taskId,
        branch,
        path: absolutePath,
      });
    }

    return result;
  } catch (error) {
    console.error("[gateway:worktree] listWorktrees failed", { error: String(error) });
    throw error;
  }
}

export function worktreeActionButtons(taskId: string): InlineButton[][] {
  const normalized = normalizeTaskId(taskId);
  return [[
    { text: "👀 View Full Diff", action: `worktree:view:${normalized}` },
    { text: "✅ Merge", action: `worktree:merge:${normalized}` },
    { text: "❌ Discard", action: `worktree:discard:${normalized}` },
  ]];
}

export function registerWorktreeCallbackHandler(bot: Bot, fallbackChatId: number): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith(WORKTREE_CALLBACK_PREFIX)) {
      await next();
      return;
    }

    const parts = data.split(":");
    if (parts.length < 3) {
      try {
        await ctx.answerCallbackQuery({ text: "Invalid worktree action" });
      } catch {}
      return;
    }

    const action = parts[1] ?? "";
    const taskId = parts.slice(2).join(":").trim();
    const chatId = ctx.callbackQuery.message?.chat.id ?? fallbackChatId;

    try {
      await ctx.answerCallbackQuery({ text: "Processing..." });
    } catch {
      // non-critical
    }

    try {
      if (action === "view") {
        const diff = await getWorktreeDiff(taskId);
        const body = diff.trim() || "(no diff)";
        const truncated = truncate(body);
        const suffix = body.length > MAX_DIFF_CHARS ? "\n\n<i>(truncated)</i>" : "";

        await bot.api.sendMessage(
          chatId,
          `<b>Diff: ${escapeHtml(taskId)}</b>\n<pre>${escapeHtml(truncated)}</pre>${suffix}`,
          { parse_mode: "HTML" },
        );
        return;
      }

      if (action === "merge") {
        const result = await mergeWorktree(taskId);
        const status = result.success ? "✅" : "❌";
        await bot.api.sendMessage(chatId, `${status} ${escapeHtml(result.message)}`, {
          parse_mode: "HTML",
        });
        return;
      }

      if (action === "discard") {
        await discardWorktree(taskId);
        await bot.api.sendMessage(chatId, `🗑️ Discarded <code>${escapeHtml(taskId)}</code>`, {
          parse_mode: "HTML",
        });
        return;
      }

      await bot.api.sendMessage(chatId, `<b>Unknown worktree action</b>: <code>${escapeHtml(action)}</code>`, {
        parse_mode: "HTML",
      });
    } catch (error) {
      console.error("[gateway:worktree] callback action failed", {
        action,
        taskId,
        error: String(error),
      });
      await bot.api.sendMessage(chatId, `<b>Worktree action failed</b>\n<code>${escapeHtml(String(error))}</code>`, {
        parse_mode: "HTML",
      });
    }
  });
}

export const BUILD_COMMAND: CommandDefinition = defineChatCommand({
  key: "build_command",
  nativeName: "build_command",
  description: "Run a build task through the gateway agent worktree flow",
  category: "meta",
  execution: "agent",
  args: [
    {
      name: "description",
      description: "Task description",
      type: "string",
      required: true,
      captureRemaining: true,
    },
  ],
});
