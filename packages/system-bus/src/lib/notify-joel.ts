import { isIP } from "node:net";
import { leaseSecretStrict } from "./voice-canary";

export type NotifyJoelInput = {
  kind: "ask" | "update" | "link" | "needs_joel";
  message: string;
  links?: string[];
  source: string;
};

type NotifyJoelDependencies = {
  leaseSecret: (name: string) => string | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};

export class NotifyJoelError extends Error {
  override readonly name = "NotifyJoelError";

  constructor(
    readonly code: "missing_secret" | "request_failed" | "http_error",
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Keep actionable basenames, not machine names or directory layouts. */
export function redactJoelMessage(message: string): string {
  const basenames: string[] = [];
  const redactPath = (path: string): string => {
    const parts = path
      .replace(/[.,;:!?)\]]+$/u, "")
      .split(/[\\/]/u)
      .filter(Boolean);
    basenames.push(parts.at(-1) ?? "[path]");
    const punctuation = path.match(/[.,;:!?)\]]+$/u)?.[0] ?? "";
    return `\uE000${basenames.length - 1}\uE001${punctuation}`;
  };
  return message
    .replace(/https?:\/\/[^\s<>"'`]+/giu, "[address]")
    .replace(
      /(["'`])((?:[a-z]:[\\/]|\\\\|~?\/|\.{1,2}\/)[^\n]*?)\1/giu,
      (_, _quote: string, path: string) => redactPath(path),
    )
    .replace(/(?<![\w/])(?:[a-z]:[\\/]|\\\\|~?\/|\.{1,2}\/)[^\s<>"'`]+/giu, redactPath)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[address]")
    .replace(/\[?[\da-f]*:[\da-f:]+(?:%[\w.-]+)?\]?/giu, (candidate) =>
      isIP(candidate.replace(/^\[|\]$/gu, "")) ? "[address]" : candidate,
    )
    .replace(/(?<![\w/.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}\b/giu, "[host]")
    .replace(/\b(host(?:name)?[=: ]+|ssh\s+)(?:[\w.-]+@)?[\w.-]+/giu, "$1[host]")
    .replace(/\bon\s+[\w.-]+\s+(failed|unreachable|refused)\b/giu, "on [host] $1")
    .replace(/[\w.-]+:(?=\uE000)/gu, "[host]:")
    .replace(/\uE000(\d+)\uE001/gu, (_, index: string) => basenames[Number(index)] ?? "[path]")
    .replace(/`/gu, "")
    .split("")
    .filter(
      (char) =>
        char === "\n" || char === "\t" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    )
    .join("")
    .slice(0, 1_500);
}

export async function notifyJoel(
  input: NotifyJoelInput,
  dependencies: NotifyJoelDependencies = {
    leaseSecret: leaseSecretStrict,
    fetch: globalThis.fetch,
  },
): Promise<void> {
  const lease = (name: string): string => {
    try {
      const value = dependencies.leaseSecret(name)?.trim();
      if (value && !value.startsWith("{")) return value;
    } catch {
      // CLI errors can include secret material. Never propagate their output.
    }
    throw new NotifyJoelError("missing_secret", `Notification secret unavailable: ${name}`);
  };

  // No cache or local-file fallback: every send needs fresh leases (10s CLI timeout).
  const url = lease("shitrat_grok_bot_webhook_url");
  const key = lease("shitrat_grok_bot_webhook_sender_key");
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source: input.source,
        event: input.kind,
        message: redactJoelMessage(input.message),
        links: input.links ?? [],
        agent: "system-bus",
        ts: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    // Do not expose the webhook URL, sender key, or response body in retry logs.
    throw new NotifyJoelError("request_failed", "Joel notification request failed or timed out");
  }
  if (!response.ok) {
    throw new NotifyJoelError(
      "http_error",
      `Joel notification rejected (HTTP ${response.status})`,
      response.status,
    );
  }
}
