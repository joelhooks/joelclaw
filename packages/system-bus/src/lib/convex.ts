/**
 * Convex HTTP client for pushing data from the worker.
 * Uses ConvexHttpClient — no WebSocket, just HTTP POST per mutation.
 *
 * ADR-0075: Dashboard wiring.
 */
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

/** Push system health status to Convex dashboard */
export async function pushSystemStatus(
  component: string,
  status: "healthy" | "degraded" | "down",
  detail?: string
) {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).systemStatus.upsert as FunctionReference<"mutation">;
  await client.mutation(ref, { component, status, detail });
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
  const client = getConvexClient();
  const ref = (anyApi as any).vaultNotes.upsert as FunctionReference<"mutation">;
  await client.mutation(ref, note);
}

/** Remove vault notes that no longer exist */
export async function removeVaultNotes(paths: string[]) {
  if (paths.length === 0) return;
  const client = getConvexClient();
  const ref = (anyApi as any).vaultNotes.removeByPaths as FunctionReference<"mutation">;
  await client.mutation(ref, { paths });
}

/** Push a notification to Convex dashboard */
export async function pushNotification(
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, unknown>
) {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).notifications.create as FunctionReference<"mutation">;
  await client.mutation(ref, { type, title, body, metadata });
}
