import { compactSession, newSession, reloadSession } from "../command-queue";
import {
  type CommandArgChoice,
  type CommandCategory,
  type CommandDefinition,
  defineChatCommand,getCommands, 
  type ParsedArgs
} from "./registry";

const MAX_PRE_CHARS = 3400;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, maxChars = MAX_PRE_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

async function runJoelclawCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["joelclaw", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function formatCliResult(title: string, result: { exitCode: number; stdout: string; stderr: string }): string {
  const body = result.stdout || result.stderr || "(no output)";
  const pre = `<pre>${escapeHtml(truncate(body))}</pre>`;

  if (result.exitCode === 0) {
    return `<b>${escapeHtml(title)}</b>\n${pre}`;
  }

  const exitLabel = `<b>Exit:</b> <code>${result.exitCode}</code>`;
  return `<b>${escapeHtml(title)}</b>\n${exitLabel}\n${pre}`;
}

function categoryLabel(category: CommandCategory): string {
  switch (category) {
    case "ops": return "Ops";
    case "session": return "Session";
    case "search": return "Search";
    case "tools": return "Tools";
    case "options": return "Options";
    case "meta": return "Meta";
    default: return "Other";
  }
}

function buildHelpHtml(): string {
  const commands = getCommands();
  const grouped = new Map<CommandCategory, CommandDefinition[]>();

  for (const command of commands) {
    const list = grouped.get(command.category) ?? [];
    list.push(command);
    grouped.set(command.category, list);
  }

  const categoryOrder: CommandCategory[] = ["ops", "tools", "search", "session", "options", "meta"];
  const lines: string[] = ["<b>Available commands</b>"];

  for (const category of categoryOrder) {
    const items = grouped.get(category);
    if (!items || items.length === 0) continue;

    items.sort((a, b) => a.nativeName.localeCompare(b.nativeName));
    lines.push("", `<b>${categoryLabel(category)}</b>`);

    for (const command of items) {
      lines.push(`<code>/${escapeHtml(command.nativeName)}</code> — ${escapeHtml(command.description)}`);
    }
  }

  return lines.join("\n");
}

function getStringArg(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return `${value}`;
  return undefined;
}

const SEND_EVENT_CHOICES: CommandArgChoice[] = [
  { value: "health-check", label: "🏥 Health Check" },
  { value: "email-triage", label: "📧 Email Triage" },
  { value: "memory-review", label: "🧠 Memory Review" },
  { value: "friction-fix", label: "🔧 Friction Fix" },
];

async function handleStatus(): Promise<string> {
  const result = await runJoelclawCommand(["status"]);
  return formatCliResult("joelclaw status", result);
}

async function handleHelp(): Promise<string> {
  return buildHelpHtml();
}

async function handleRuns(): Promise<string> {
  const result = await runJoelclawCommand(["runs", "-n", "5"]);
  return formatCliResult("joelclaw runs -n 5", result);
}

async function handleHealth(): Promise<string> {
  const result = await runJoelclawCommand(["gateway", "status"]);
  return formatCliResult("joelclaw gateway status", result);
}

async function handleReload(): Promise<string> {
  try {
    await reloadSession();
    return "✅ Reloaded extensions, skills, and prompts.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<b>Reload failed</b>\n<code>${escapeHtml(message)}</code>`;
  }
}

async function handleCompact(): Promise<string> {
  try {
    await compactSession();
    return "✅ Context compacted.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<b>Compact failed</b>\n<code>${escapeHtml(message)}</code>`;
  }
}

async function handleNewSession(): Promise<string> {
  try {
    await newSession();
    return "✅ New session started.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<b>New session failed</b>\n<code>${escapeHtml(message)}</code>`;
  }
}

async function handleSearch(parsed: ParsedArgs): Promise<string> {
  const query = (getStringArg(parsed, "query") ?? parsed.raw).trim();
  if (!query) {
    return "<b>Missing argument</b>\nUse <code>/search &lt;query&gt;</code>.";
  }

  const result = await runJoelclawCommand(["search", query]);
  return formatCliResult(`joelclaw search ${query}`, result);
}

async function handleSend(parsed: ParsedArgs): Promise<string> {
  const eventName = getStringArg(parsed, "event") ?? parsed.positional[0];
  if (!eventName) {
    return "<b>Missing argument</b>\nUse <code>/send &lt;event&gt;</code>.";
  }

  const result = await runJoelclawCommand(["send", eventName]);
  return formatCliResult(`joelclaw send ${eventName}`, result);
}

async function handleSleep(args: ParsedArgs): Promise<string> {
  const duration = args.positional?.[0];
  const cmdArgs = ["sleep"];
  if (duration) cmdArgs.push("--for", String(duration));
  const result = await runJoelclawCommand(cmdArgs);
  if (result.exitCode === 0) {
    return duration ? `🌙 Sleep mode activated for ${duration}` : "🌙 Sleep mode activated";
  }
  return formatCliResult("joelclaw sleep", result);
}

async function handleWake(): Promise<string> {
  const result = await runJoelclawCommand(["wake"]);
  if (result.exitCode === 0) {
    return "☀️ Wake event sent — digest incoming";
  }
  return formatCliResult("joelclaw wake", result);
}

export const BUILTIN_COMMANDS: CommandDefinition[] = [
  defineChatCommand({
    key: "status",
    nativeName: "status",
    description: "Show gateway status",
    category: "ops",
    execution: "direct",
    directHandler: handleStatus,
  }),
  defineChatCommand({
    key: "help",
    nativeName: "help",
    description: "List available commands",
    category: "session",
    execution: "direct",
    directHandler: handleHelp,
  }),
  defineChatCommand({
    key: "commands",
    nativeName: "commands",
    description: "Alias for /help",
    category: "session",
    execution: "direct",
    directHandler: handleHelp,
  }),
  defineChatCommand({
    key: "runs",
    nativeName: "runs",
    description: "Show recent gateway runs",
    category: "ops",
    execution: "direct",
    directHandler: handleRuns,
  }),
  defineChatCommand({
    key: "health",
    nativeName: "health",
    description: "Show detailed gateway health",
    category: "ops",
    execution: "direct",
    directHandler: handleHealth,
  }),
  defineChatCommand({
    key: "reload",
    nativeName: "reload",
    description: "Reload extensions, skills, and prompts",
    category: "session",
    execution: "direct",
    directHandler: handleReload,
  }),
  defineChatCommand({
    key: "compact",
    nativeName: "compact",
    description: "Compact current session context",
    category: "session",
    execution: "direct",
    directHandler: handleCompact,
  }),
  defineChatCommand({
    key: "new",
    nativeName: "new",
    description: "Start a new gateway session",
    category: "session",
    execution: "direct",
    directHandler: handleNewSession,
  }),
  defineChatCommand({
    key: "search",
    nativeName: "search",
    description: "Search across system knowledge",
    category: "search",
    execution: "direct",
    args: [
      {
        name: "query",
        description: "Search query",
        type: "string",
        required: true,
        captureRemaining: true,
      },
    ],
    directHandler: handleSearch,
  }),
  defineChatCommand({
    key: "send",
    nativeName: "send",
    description: "Send a common gateway event",
    category: "tools",
    execution: "direct",
    args: [
      {
        name: "event",
        description: "Event name to send",
        type: "string",
        required: true,
        choices: SEND_EVENT_CHOICES,
      },
    ],
    argsMenu: { arg: "event", title: "Choose an event to send:" },
    directHandler: handleSend,
  }),
  defineChatCommand({
    key: "sleep",
    nativeName: "sleep",
    description: "Sleep mode — queue non-critical events",
    category: "ops",
    execution: "direct",
    args: [
      {
        name: "duration",
        description: "Optional duration (e.g. 2h, 30m)",
        type: "string",
        required: false,
      },
    ],
    directHandler: handleSleep,
  }),
  defineChatCommand({
    key: "wake",
    nativeName: "wake",
    description: "Wake up — deliver queued event digest",
    category: "ops",
    execution: "direct",
    directHandler: handleWake,
  }),
];
