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

/**
 * Resolve PDS credentials from agent-secrets via secrets CLI.
 * Falls back to env vars for k8s worker pods.
 */
async function getCredentials(): Promise<{ did: string; password: string }> {
  const did =
    process.env.PDS_JOEL_DID ??
    (await shellLease("pds_joel_did"));
  const password =
    process.env.PDS_JOEL_PASSWORD ??
    (await shellLease("pds_joel_password"));

  if (!did || !password) {
    throw new Error("PDS credentials unavailable (pds_joel_did / pds_joel_password)");
  }

  return { did, password };
}

async function shellLease(name: string): Promise<string> {
  try {
    const proc = Bun.spawn(["secrets", "lease", name, "--ttl", "1h"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
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

  const { did, password } = await getCredentials();

  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: did, password }),
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
