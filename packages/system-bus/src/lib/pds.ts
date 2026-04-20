/**
 * PDS client — thin XRPC wrapper for writing records to the AT Proto PDS.
 *
 * Used for dual-write: after slog/memory/observe writes to their primary stores,
 * they also write a typed record to the PDS for portable, federated access.
 *
 * ADR-0004: AT Protocol as bedrock
 * ADR-0044: Private-first PDS with Bento bridge
 */

const PDS_URL = process.env.PDS_URL ?? "http://localhost:9627";

interface PdsSession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
  createdAt: number;
}

let cachedSession: PdsSession | null = null;

async function resolveSessionIdentifier(did: string): Promise<string> {
  const explicitIdentifier =
    process.env.PDS_JOEL_IDENTIFIER ??
    process.env.PDS_JOEL_HANDLE ??
    (await shellLease("pds_joel_handle"));

  if (explicitIdentifier) {
    return explicitIdentifier;
  }

  try {
    const res = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { handle?: string };
      if (data.handle) {
        return data.handle;
      }
    }
  } catch {
    // fall back to DID below
  }

  return did;
}

/**
 * Resolve PDS credentials from agent-secrets via secrets CLI.
 * Falls back to env vars for k8s worker pods.
 */
async function getCredentials(): Promise<{ did: string; password: string; identifier: string }> {
  const did =
    process.env.PDS_JOEL_DID ??
    (await shellLease("pds_joel_did"));
  const password =
    process.env.PDS_JOEL_PASSWORD ??
    (await shellLease("pds_joel_password"));

  if (!did || !password) {
    throw new Error("PDS credentials unavailable (pds_joel_did / pds_joel_password)");
  }

  const identifier = await resolveSessionIdentifier(did);
  return { did, password, identifier };
}

async function shellLease(name: string): Promise<string> {
  try {
    const proc = Bun.spawn(["secrets", "lease", name, "--ttl", "1h"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const trimmed = text.trim();
    if (!trimmed) {
      return "";
    }

    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as {
          ok?: boolean;
          success?: boolean;
          value?: string;
          result?: { value?: string };
        };
        if (parsed.ok === false || parsed.success === false) {
          return "";
        }
        return parsed.value ?? parsed.result?.value ?? "";
      } catch {
        // raw secret values are not expected to be JSON; fall through
      }
    }

    return trimmed;
  } catch {
    return "";
  }
}

/**
 * Get or refresh a PDS session. Sessions are cached in memory
 * and refreshed when older than 90 minutes.
 */
async function getSession(): Promise<PdsSession> {
  const now = Date.now();

  // Reuse if < 90 minutes old
  if (cachedSession && now - cachedSession.createdAt < 90 * 60 * 1000) {
    return cachedSession;
  }

  const { password, identifier } = await getCredentials();

  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PDS createSession failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    accessJwt: string;
    refreshJwt: string;
    did: string;
    handle: string;
  };

  cachedSession = { ...data, createdAt: now };
  return cachedSession;
}

/**
 * Write a record to the PDS.
 *
 * @param collection - Lexicon collection (e.g. "dev.joelclaw.system.log")
 * @param record - Record data (without $type or createdAt — added automatically)
 * @returns The AT URI and CID of the created record, or null on failure
 */
export async function pdsWriteRecord(
  collection: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string } | null> {
  try {
    const session = await getSession();

    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessJwt}`,
      },
      body: JSON.stringify({
        repo: session.did,
        collection,
        record: {
          $type: collection,
          createdAt: new Date().toISOString(),
          ...record,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`PDS write failed (${res.status}): ${body}`);
      // Invalidate session on auth errors
      if (res.status === 401) {
        cachedSession = null;
      }
      return null;
    }

    const data = (await res.json()) as { uri: string; cid: string };
    return { uri: data.uri, cid: data.cid };
  } catch (error) {
    // PDS writes are best-effort — never block the primary pipeline
    console.error("PDS write error:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Write a system log entry to the PDS.
 * Maps 1:1 to dev.joelclaw.system.log lexicon.
 */
export async function pdsWriteSystemLog(entry: {
  timestamp: string;
  action: string;
  tool: string;
  detail: string;
  reason?: string;
  sessionId?: string;
  systemId?: string;
}): Promise<{ uri: string; cid: string } | null> {
  return pdsWriteRecord("dev.joelclaw.system.log", entry);
}

/**
 * Write a memory observation to the PDS.
 * Maps to dev.joelclaw.memory.observation lexicon.
 */
export async function pdsWriteObservation(entry: {
  observation: string;
  source: string;
  category?: string;
  timestamp: string;
}): Promise<{ uri: string; cid: string } | null> {
  return pdsWriteRecord("dev.joelclaw.memory.observation", entry);
}

/**
 * Check PDS health. Returns version string or null if unreachable.
 */
export async function pdsHealth(): Promise<string | null> {
  try {
    const res = await fetch(`${PDS_URL}/xrpc/_health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

/**
 * ADR-0243 Rule 20: create an AT Protocol App Password for the caller's
 * DID. Used during joelclaw-machine-register to mint per-Machine
 * credentials.
 *
 * App Passwords are revocable individually and can have "privileged" scope
 * (default: false — app password has restricted perms vs full credentials).
 */
export async function pdsCreateAppPassword(params: {
  name: string;
  privileged?: boolean;
}): Promise<{ name: string; password: string; createdAt: string; did: string; handle: string }> {
  const session = await getSession();
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAppPassword`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({ name: params.name, privileged: params.privileged ?? false }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PDS createAppPassword failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    name: string;
    password: string;
    createdAt: string;
    privileged?: boolean;
  };
  return { ...data, did: session.did, handle: session.handle };
}

/**
 * ADR-0243 Rule 20: revoke a previously-issued App Password by name.
 */
export async function pdsRevokeAppPassword(name: string): Promise<boolean> {
  const session = await getSession();
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.revokeAppPassword`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({ name }),
  });
  return res.ok;
}

/**
 * ADR-0243 Rule 20: validate an App Password by creating a session with it.
 * Returns the caller's DID + handle on success. Used at register time to
 * prove the password is real before we store its hash; NOT called per-request
 * (that's what the Machine-row lookup is for — hash-based auth is cheaper
 * and doesn't create server-side session state at the PDS).
 */
export async function pdsValidateAppPassword(
  identifier: string,
  appPassword: string
): Promise<{ did: string; handle: string } | null> {
  try {
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password: appPassword }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { did: string; handle: string };
    return { did: data.did, handle: data.handle };
  } catch {
    return null;
  }
}
