/**
 * Credential storage and the pairing exchange. A pairing token is single-use;
 * the bearer it buys lasts ~30 days and is what we persist.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface T3Credentials {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly scope: string;
  readonly obtainedAt: string;
  readonly expiresAt: string;
}

export const defaultCredentialsPath = (): string =>
  process.env.T3_CLIENT_CREDENTIALS ?? join(homedir(), ".joelclaw", "t3-client.json");

export async function loadCredentials(path = defaultCredentialsPath()): Promise<T3Credentials> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T3Credentials;
  } catch {
    throw new Error(
      `No T3 credentials at ${path}. Pair first: t3c pair '<pairing-url-or-token>' --url <server>`,
    );
  }
}

export async function saveCredentials(
  credentials: T3Credentials,
  path = defaultCredentialsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Accepts a bare pairing token or a full pairing URL (`…/pair#token=XXX`). */
export function parsePairingToken(input: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(input);
  return match ? match[1]! : input.trim();
}

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** Exchange a single-use pairing token for a bearer (RFC 8693, form-encoded). */
export async function exchangePairingToken(input: {
  readonly baseUrl: string;
  readonly pairingToken: string;
  readonly clientLabel?: string;
}): Promise<T3Credentials> {
  const response = await fetch(`${input.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: parsePairingToken(input.pairingToken),
      subject_token_type: BOOTSTRAP_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      client_label: input.clientLabel ?? "joelclaw-gateway",
    }).toString(),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`pairing exchange failed (${response.status}): ${body}`);
  }
  const token = JSON.parse(body) as { access_token: string; expires_in: number; scope: string };
  const now = Date.now();
  return {
    baseUrl: input.baseUrl,
    bearerToken: token.access_token,
    scope: token.scope,
    obtainedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + token.expires_in * 1000).toISOString(),
  };
}

/** Bearer → single-use WebSocket ticket → connectable ws URL. */
export async function issueSocketUrl(credentials: T3Credentials): Promise<string> {
  const response = await fetch(`${credentials.baseUrl}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.bearerToken}` },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`websocket ticket failed (${response.status}): ${body}`);
  }
  const { ticket } = JSON.parse(body) as { ticket: string };
  const url = new URL(credentials.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}
