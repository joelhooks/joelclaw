/**
 * Convex HTTP client for pushing data from the worker.
 * Uses ConvexHttpClient — no WebSocket, just HTTP POST per mutation.
 *
 * ADR-0075: Dashboard wiring.
 */
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";

const CONVEX_URL = process.env.CONVEX_URL ?? "https://tough-panda-917.convex.cloud";

let _client: ConvexHttpClient | null = null;

export function getConvexClient(): ConvexHttpClient {
  if (!_client) {
    _client = new ConvexHttpClient(CONVEX_URL);
  }
  return _client;
}

/** Upsert a unified content resource to Convex */
export async function pushContentResource(
  resourceId: string,
  type: string,
  fields: Record<string, unknown>,
  searchText?: string
) {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.upsert as FunctionReference<"mutation">;
  await client.mutation(ref, { resourceId, type, fields, searchText });
}

/** Push system health status to Convex dashboard */
export async function pushSystemStatus(
  component: string,
  status: "healthy" | "degraded" | "down",
  detail?: string
) {
  await pushContentResource(
    `status:${component}`,
    "system_status",
    { component, status, detail, checkedAt: Date.now() },
    [component, status, detail].filter(Boolean).join(" ")
  );
}

/** Upsert a vault note to Convex */
export async function pushVaultNote(note: {
  path: string;
  title: string;
  content: string;
  html?: string;
  type: string;
  tags: string[];
  section: string;
  updatedAt: number;
}) {
  await pushContentResource(
    `vault:${note.path}`,
    "vault_note",
    note,
    [note.title, note.content, note.tags.join(" "), note.section, note.type]
      .filter(Boolean)
      .join(" ")
  );
}

/** Remove vault notes that no longer exist */
export async function removeVaultNotes(paths: string[]) {
  if (paths.length === 0) return;
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.remove as FunctionReference<"mutation">;

  for (const path of paths) {
    await client.mutation(ref, { resourceId: `vault:${path}` });
  }
}

/** Push a memory observation to Convex */
export async function pushMemoryObservation(obs: {
  observationId: string;
  observation: string;
  category: string;
  source: string;
  sessionId?: string;
  superseded: boolean;
  timestamp: number;
}) {
  await pushContentResource(
    `obs:${obs.observationId}`,
    "memory_observation",
    obs,
    [obs.observation, obs.category, obs.source].filter(Boolean).join(" ")
  );
}

/** Push a system log entry to Convex */
export async function pushSystemLogEntry(entry: {
  entryId: string;
  action: string;
  tool: string;
  detail: string;
  reason?: string;
  timestamp: number;
}) {
  await pushContentResource(
    `slog:${entry.entryId}`,
    "system_log",
    entry,
    [entry.action, entry.tool, entry.detail, entry.reason].filter(Boolean).join(" ")
  );
}

/** Push a notification to Convex dashboard */
export async function pushNotification(
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, unknown>
) {
  const notificationId =
    (typeof metadata?.id === "string" && metadata.id) ||
    (typeof metadata?.notificationId === "string" && metadata.notificationId) ||
    randomUUID();
  await pushContentResource(
    `notif:${notificationId}`,
    "notification",
    {
      notificationType: type,
      title,
      body,
      metadata,
      read: false,
      createdAt: Date.now(),
    },
    [type, title, body].filter(Boolean).join(" ")
  );
}
