import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_INNGEST_URL = "http://localhost:8288";

const ENV_PATHS = [
  join(homedir(), ".config", "inngest", "env"),
  join(homedir(), ".config", "system-bus.env"),
  join(homedir(), "Code", "joelhooks", "joelclaw", "packages", "system-bus", ".env"),
  "/Users/Shared/joelclaw/etc/inngest/inngest.env",
];

export interface GatewayInngestEventConfig {
  readonly eventKey: string;
  readonly inngestUrl: string;
  readonly eventApi: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvValue(name: string): string {
  const pattern = new RegExp(`^(?:export\\s+)?${name}=(.+)$`, "m");

  for (const filePath of ENV_PATHS) {
    if (!existsSync(filePath)) continue;

    const match = readFileSync(filePath, "utf-8").match(pattern);
    if (!match) continue;

    const value = unquote(match[1] ?? "");
    if (value) return value;
  }

  return "";
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function loadGatewayInngestEventConfig(): GatewayInngestEventConfig | null {
  const eventKey =
    process.env.INNGEST_EVENT_KEY?.trim() ||
    readEnvValue("INNGEST_EVENT_KEY");

  if (!eventKey) return null;

  const inngestUrl = normalizeBaseUrl(
    process.env.INNGEST_URL?.trim() ||
      process.env.INNGEST_BASE_URL?.trim() ||
      readEnvValue("INNGEST_URL") ||
      readEnvValue("INNGEST_BASE_URL") ||
      DEFAULT_INNGEST_URL,
  );

  return {
    eventKey,
    inngestUrl,
    eventApi: `${inngestUrl}/e/${eventKey}`,
  };
}
