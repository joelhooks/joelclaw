import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/**
 * Auth for the worker's /internal/* and /observability/emit routes.
 *
 * These routes enqueue work and dispatch agents, so they fail closed: with no
 * configured OTEL_EMIT_TOKEN every request is refused (503), and a missing or
 * wrong token is refused (401). INTERNAL_AUTH_MODE=log-only is the rollout
 * switch: requests pass, and each unauthenticated caller is logged so it can
 * be given the token before enforcement.
 */
export type InternalAuthMode = "enforce" | "log-only";

export type InternalAuthReason = "ok" | "no-token-configured" | "missing-token" | "bad-token";

export interface InternalAuthDecision {
  readonly allow: boolean;
  readonly reason: InternalAuthReason;
  readonly status?: 401 | 503;
  readonly logOnly?: boolean;
}

export const internalAuthMode = (value = process.env.INTERNAL_AUTH_MODE): InternalAuthMode =>
  value?.trim().toLowerCase() === "log-only" ? "log-only" : "enforce";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison; hashing first makes the lengths equal. */
export const tokensMatch = (presented: string | undefined, configured: string | undefined): boolean => {
  if (!presented || !configured) return false;
  return timingSafeEqual(digest(presented), digest(configured));
};

export const decideInternalAuth = (input: {
  readonly configured: string | undefined;
  readonly presented: string | undefined;
  readonly mode: InternalAuthMode;
}): InternalAuthDecision => {
  const configured = input.configured?.trim();
  const presented = input.presented?.trim();
  let reason: InternalAuthReason;
  if (!configured) reason = "no-token-configured";
  else if (!presented) reason = "missing-token";
  else if (!tokensMatch(presented, configured)) reason = "bad-token";
  else return { allow: true, reason: "ok" };
  if (input.mode === "log-only") return { allow: true, reason, logOnly: true };
  return { allow: false, reason, status: reason === "no-token-configured" ? 503 : 401 };
};

export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
};

/** One log line per (route, caller, reason) per window, so log-only mode can't flood the log. */
export const createDenialLogger = (options: {
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly sink?: (line: string) => void;
} = {}) => {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const sink = options.sink ?? ((line: string) => console.warn(line));
  const last = new Map<string, number>();
  return (entry: {
    readonly route: string;
    readonly caller: string | undefined;
    readonly userAgent: string | undefined;
    readonly decision: InternalAuthDecision;
  }) => {
    const key = `${entry.route}|${entry.caller ?? "?"}|${entry.decision.reason}`;
    const t = now();
    const seen = last.get(key);
    if (seen !== undefined && t - seen < windowMs) return false;
    last.set(key, t);
    const verdict = entry.decision.allow ? "allowed (log-only)" : "refused";
    sink(
      `[internal-auth] ${verdict} ${entry.route} caller=${entry.caller ?? "?"} reason=${entry.decision.reason} ua=${(entry.userAgent ?? "").slice(0, 80)}`,
    );
    return true;
  };
};

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", "[::]"]);

/**
 * Addresses the worker listens on. WORKER_BIND_HOSTS (comma-separated) wins;
 * otherwise loopback plus the host Inngest is told to call (INNGEST_SERVE_HOST),
 * when that is an IP literal. Never a wildcard: that is what exposed these
 * routes to every network the machine is on.
 */
export const resolveBindHosts = (env: Record<string, string | undefined> = process.env): string[] => {
  const explicit = env.WORKER_BIND_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
  let hosts: string[];
  if (explicit && explicit.length > 0) {
    hosts = explicit;
  } else {
    hosts = ["127.0.0.1"];
    const serveHost = env.INNGEST_SERVE_HOST?.trim();
    if (serveHost) {
      try {
        const host = new URL(serveHost).hostname.replace(/^\[|\]$/g, "");
        if (isIP(host) && !isLoopbackAddress(host)) hosts.push(host);
      } catch {
        // Not a URL; loopback only.
      }
    }
  }
  const wild = hosts.filter((h) => WILDCARD_HOSTS.has(h));
  if (wild.length > 0) {
    throw new Error(
      `refusing to bind ${wild.join(", ")}: a wildcard listener exposes internal routes to every network. Set WORKER_BIND_HOSTS to loopback plus the tailnet address.`,
    );
  }
  return [...new Set(hosts)];
};

type ServeFn = (options: { hostname: string; port: number; idleTimeout?: number; fetch: (...args: any[]) => any }) => unknown;

/**
 * Listens on every host. A loopback bind failure is fatal; any other address
 * (the tailnet one may not exist yet at boot) is retried until it binds, so
 * loopback callers keep working meanwhile.
 */
export const serveOnHosts = (options: {
  readonly hosts: readonly string[];
  readonly port: number;
  readonly fetch: (...args: any[]) => any;
  readonly idleTimeout?: number;
  readonly retryMs?: number;
  readonly serve?: ServeFn;
  readonly log?: (line: string) => void;
}) => {
  const serve: ServeFn = options.serve ?? ((o) => Bun.serve(o as any));
  const log = options.log ?? ((line: string) => console.warn(line));
  const retryMs = options.retryMs ?? 5_000;
  const bind = (hostname: string) => {
    try {
      serve({ hostname, port: options.port, fetch: options.fetch, ...(options.idleTimeout ? { idleTimeout: options.idleTimeout } : {}) });
      log(`[serve] listening on ${hostname}:${options.port}`);
    } catch (error) {
      if (isLoopbackAddress(hostname)) throw error;
      log(`[serve] cannot bind ${hostname}:${options.port} yet (${error instanceof Error ? error.message : String(error)}); retrying in ${retryMs}ms`);
      setTimeout(() => bind(hostname), retryMs);
    }
  };
  for (const host of options.hosts) bind(host);
};
