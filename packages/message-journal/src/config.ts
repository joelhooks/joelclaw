import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";
import type { ClickHouseIdentity } from "./clickhouse";

const SYSTEM_BUS_ENV_PATH = join(homedir(), ".config", "system-bus.env");
const DEFAULT_CLICKHOUSE_URL = "http://localhost:8123";
export const DEFAULT_JOURNAL_DATABASE = "joelclaw_private";
export const DEFAULT_JOURNAL_TABLE = "message_journal_events";

export type JournalIdentityRole = "admin" | "writer" | "reader";

export interface MessageJournalConnection extends ClickHouseIdentity {
  readonly database: string;
  readonly table: string;
}

export class MessageJournalConfigError extends Data.TaggedError("MessageJournalConfigError")<{
  readonly role: JournalIdentityRole;
  readonly missing: ReadonlyArray<string>;
}> {}

export function readEnvFile(path = SYSTEM_BUS_ENV_PATH): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/u, "$2");
  }
  return values;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveMessageJournalConnection(
  role: JournalIdentityRole,
  env: NodeJS.ProcessEnv = process.env,
  fileEnv: Record<string, string> = readEnvFile()
): Effect.Effect<MessageJournalConnection, MessageJournalConfigError> {
  const value = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const resolved = nonEmpty(env[key]) ?? nonEmpty(fileEnv[key]);
      if (resolved) return resolved;
    }
    return undefined;
  };

  const prefix = `MESSAGE_JOURNAL_${role.toUpperCase()}`;
  const username = value(`${prefix}_USER`);
  const password = value(`${prefix}_PASSWORD`);
  const missing = [
    ...(username ? [] : [`${prefix}_USER`]),
    ...(password ? [] : [`${prefix}_PASSWORD`]),
  ];

  if (!username || !password) {
    return Effect.fail(new MessageJournalConfigError({ role, missing }));
  }

  return Effect.succeed({
    url:
      value("MESSAGE_JOURNAL_CLICKHOUSE_URL", "CLICKHOUSE_URL") ?? DEFAULT_CLICKHOUSE_URL,
    database: value("MESSAGE_JOURNAL_DATABASE") ?? DEFAULT_JOURNAL_DATABASE,
    table: value("MESSAGE_JOURNAL_TABLE") ?? DEFAULT_JOURNAL_TABLE,
    username,
    password,
  });
}
