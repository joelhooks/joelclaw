import { createHash } from "node:crypto";
import type { MemoryIdentity } from "./run-capture";

export type CaptureIdentityLookupOptions = {
  token: string;
  typesenseUrl: string;
  typesenseApiKey: string;
  machinesCollection: string;
  timeoutMs?: number;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_TIMEOUT_MS = 1_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

export async function lookupCaptureIdentity(
  options: CaptureIdentityLookupOptions,
): Promise<MemoryIdentity | null> {
  const hash = createHash("sha256").update(options.token).digest("hex");
  const params = new URLSearchParams({
    q: hash,
    query_by: "app_password_sha256",
    filter_by: `app_password_sha256:=\`${hash}\``,
    per_page: "1",
  });

  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${options.typesenseUrl}/collections/${options.machinesCollection}/documents/search?${params}`,
      {
        headers: { "X-TYPESENSE-API-KEY": options.typesenseApiKey },
        signal: AbortSignal.timeout(positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)),
      },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      hits?: Array<{
        document: {
          id?: unknown;
          user_id?: unknown;
          did?: unknown;
          revoked_at?: unknown;
        };
      }>;
    };
    const hit = data.hits?.[0]?.document;
    if (
      !hit ||
      typeof hit.id !== "string" ||
      typeof hit.user_id !== "string" ||
      hit.revoked_at
    ) {
      return null;
    }
    return {
      user_id: hit.user_id,
      machine_id: hit.id,
      did: typeof hit.did === "string" ? hit.did : null,
    };
  } catch {
    return null;
  }
}
