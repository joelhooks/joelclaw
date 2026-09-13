import { execFile } from "node:child_process";

export const DEFAULT_IMSG_BIN = "/opt/homebrew/bin/imsg";
export const MAX_TEXT_CHARS = 4_000;
export const TRUNCATION_MARKER = "…[truncated]";
export const FDA_MESSAGE =
  "Full Disk Access is not granted to the responsible process; grant it to /Applications/imsg-mcp.app";
export const AUTOMATION_MESSAGE =
  "Automation access to Messages is not granted; grant Automation → Messages to /Applications/imsg-mcp.app in System Settings › Privacy & Security › Automation";
export const KILLED_MESSAGE = "send outcome unknown; check Messages.app before retrying";
export const READ_TIMEOUT_MS = 60_000;

export function readTimeoutMessage(timeoutMs: number = READ_TIMEOUT_MS): string {
  return `imsg timed out after ${Math.round(timeoutMs / 1000)}s; reduce limit or narrow the window`;
}

export interface ErrorTextContext {
  /** Which kind of tool failed; a killed read tool gets the timeout hint, a killed send the unknown-outcome text. */
  readonly kind?: "send" | "read";
  readonly timeoutMs?: number;
}

const FDA_PATTERNS = [/authorization denied/iu, /full disk access/iu];
const AUTOMATION_PATTERNS = [/applescript/iu, /automation/iu, /-1743/u, /not permitted to send apple events/iu];
export const DEFAULT_TIMEOUT_MS = READ_TIMEOUT_MS;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type ImsgFailureClass = "fda" | "automation" | "killed" | "other";

export class ImsgError extends Error {
  readonly failure: ImsgFailureClass;
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null, failure: ImsgFailureClass) {
    super(message);
    this.name = "ImsgError";
    this.exitCode = exitCode;
    this.failure = failure;
  }
  get permission(): boolean {
    return this.failure === "fda";
  }
}

export interface ImsgRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ImsgExecOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type ImsgExec = (args: readonly string[], options?: ImsgExecOptions) => Promise<ImsgRunResult>;

export interface ImsgCliOptions {
  readonly bin?: string;
  readonly timeoutMs?: number;
}

export function isPermissionFailure(output: string): boolean {
  return FDA_PATTERNS.some((pattern) => pattern.test(output));
}

export function isAutomationFailure(output: string): boolean {
  return AUTOMATION_PATTERNS.some((pattern) => pattern.test(output));
}

export function classifyFailure(output: string): ImsgFailureClass {
  if (isPermissionFailure(output)) return "fda";
  if (isAutomationFailure(output)) return "automation";
  return "other";
}

export function resolveImsgBin(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.IMSG_MCP_BIN?.trim();
  return value === undefined || value === "" ? DEFAULT_IMSG_BIN : value;
}

export function createImsgExec(options: ImsgCliOptions = {}): ImsgExec {
  const bin = options.bin ?? resolveImsgBin();
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (args, options = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(
        bin,
        [...args],
        {
          timeout: options.timeoutMs ?? timeout,
          maxBuffer: MAX_OUTPUT_BYTES,
          signal: options.signal,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolvePromise({ stdout, stderr });
            return;
          }
          const exitCode = typeof error.code === "number" ? error.code : null;
          const combined = `${stderr}\n${stdout}`.trim();
          const detail = combined === "" ? error.message : combined;
          const killed = error.killed === true || typeof error.signal === "string" || error.name === "AbortError";
          rejectPromise(new ImsgError(detail, exitCode, killed ? "killed" : classifyFailure(detail)));
        },
      );
    });
}

export interface NdjsonResult {
  readonly rows: unknown[];
  readonly warnings: string[];
}

export function parseNdjson(stdout: string): NdjsonResult {
  const rows: unknown[] = [];
  const warnings: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      warnings.push(`imsg emitted a non-JSON line: ${trimmed.slice(0, 200)}`);
    }
  }
  if (rows.length === 0 && warnings.length > 0) {
    throw new ImsgError(warnings.join("\n"), null, "other");
  }
  return { rows, warnings };
}

export function truncateText(value: string, max: number = MAX_TEXT_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}${TRUNCATION_MARKER}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncateMessageTexts(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!isRecord(row) || typeof row.text !== "string") return row;
    return { ...row, text: truncateText(row.text) };
  });
}

export function toErrorText(error: unknown, context: ErrorTextContext = {}): string {
  if (error instanceof ImsgError) {
    switch (error.failure) {
      case "fda":
        return `${FDA_MESSAGE}\n\nimsg said:\n${error.message}`;
      case "automation":
        return `${AUTOMATION_MESSAGE}\n\nimsg said:\n${error.message}`;
      case "killed": {
        const headline = context.kind === "read" ? readTimeoutMessage(context.timeoutMs) : KILLED_MESSAGE;
        return `${headline}\n\nimsg said:\n${error.message}`;
      }
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runImsgJson(
  exec: ImsgExec,
  args: readonly string[],
  options?: ImsgExecOptions,
): Promise<NdjsonResult> {
  const { stdout } = await exec([...args, "--json"], options);
  return parseNdjson(stdout);
}

export async function imsgVersion(exec: ImsgExec): Promise<string | null> {
  try {
    const { stdout } = await exec(["--version"]);
    const version = stdout.trim().split("\n")[0]?.trim() ?? "";
    return version === "" ? null : version;
  } catch {
    return null;
  }
}
