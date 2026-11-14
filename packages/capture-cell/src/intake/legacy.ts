import { assertLegacyInline, legacyBodyMetadata } from "./legacy-body";
import {
  acknowledge,
  blobPath,
  type IntakeMetadata,
  type IntakeStore,
  owedPage,
  transferToLegacy,
} from "./store";
import { inlineBody } from "./stream";

export interface LegacyDrainReport {
  runs: string[];
  sent: string[];
  failed: string[];
  dryRun: boolean;
}
/** Transfer first, then resend. Lost replies retry original IDs and bytes. */
export async function drainToLegacy(
  store: IntakeStore,
  options: {
    dryRun: boolean;
    send?: (metadata: IntakeMetadata, path: string) => Promise<void>;
    now?: () => number;
  },
): Promise<LegacyDrainReport> {
  if (!options.dryRun && !options.send) throw new Error("legacy drain needs a sender");
  const report: LegacyDrainReport = { runs: [], sent: [], failed: [], dryRun: options.dryRun };
  let after = 0;
  for (;;) {
    const page = owedPage(store, after, 100, true);
    if (!page.length) break;
    for (const row of page) {
      after = row.seq;
      report.runs.push(row.run_id);
      if (options.dryRun) continue;
      try {
        await assertLegacyInline(row.metadata, blobPath(store, row.id));
        const transfer = transferToLegacy(
          store,
          row.id,
          row.metadata.jsonl_sha256,
          false,
          row.transfer_epoch,
        );
        if (!transfer.transferred) continue;
        await options.send!(row.metadata, blobPath(store, row.id));
        if (
          !acknowledge(
            store,
            row.id,
            row.metadata.jsonl_sha256,
            (options.now ?? Date.now)(),
            transfer.transfer_token,
          )
        )
          throw new Error("legacy ack failed");
        report.sent.push(row.run_id);
      } catch {
        report.failed.push(row.run_id);
      }
    }
  }
  return report;
}
/** Run on the appender host: every intake operation is inbound to the intake. */
export async function drainRemoteToLegacy(options: {
  url: string;
  token: string;
  runDir: string;
  dryRun: boolean;
  send?: (metadata: IntakeMetadata, path: string) => Promise<void>;
  fetch?: typeof fetch;
}): Promise<LegacyDrainReport> {
  if (!options.dryRun && !options.send) throw new Error("legacy drain needs a sender");
  const { createAppender } = await import("./appender");
  const worker = createAppender({
    url: options.url,
    token: options.token,
    runDir: options.runDir,
    sessionsDbPath: "",
    compareOnly: false,
    load: () => ({ load1: 0, cpus: 1 }),
    fetch: options.fetch,
    deliverLegacy:
      options.send ??
      (async () => {
        throw new Error("dry-run must never forward");
      }),
  });
  const report: LegacyDrainReport = { runs: [], sent: [], failed: [], dryRun: options.dryRun };
  let after = 0;
  for (;;) {
    if (options.dryRun) {
      const rows = await worker.page(after, true);
      if (!rows.length) break;
      report.runs.push(...rows.map((row) => row.run_id));
      after = rows.at(-1)!.seq;
    } else {
      const result = await worker.tick(after);
      if (result.after === 0) break;
      report.runs.push(...(result.completed ?? []), ...(result.failedRuns ?? []));
      report.sent.push(...(result.completed ?? []));
      report.failed.push(...(result.failedRuns ?? []));
      after = result.after;
    }
  }
  return report;
}

/** Explicit recovery after stopping drains: invalidate old capabilities and restore writer discovery. */
export async function transferRemoteBack(options: {
  url: string;
  token: string;
  dryRun: boolean;
  fetch?: typeof fetch;
}): Promise<{ runs: string[]; returned: string[]; failed: string[]; dryRun: boolean }> {
  const { createAppender } = await import("./appender");
  const worker = createAppender({
    ...options,
    runDir: "",
    sessionsDbPath: "",
    compareOnly: true,
    load: () => ({ load1: 0, cpus: 1 }),
  });
  const report = {
    runs: [] as string[],
    returned: [] as string[],
    failed: [] as string[],
    dryRun: options.dryRun,
  };
  let after = 0;
  for (;;) {
    const rows = await worker.page(after, true);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.seq;
      if (row.owner !== "legacy") continue;
      report.runs.push(row.run_id);
      if (options.dryRun) continue;
      try {
        if (await worker.transferBack(row)) report.returned.push(row.run_id);
      } catch {
        report.failed.push(row.run_id);
      }
    }
  }
  return report;
}

export function createLegacySender(options: {
  url: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}) {
  if (!options.url || !options.token) throw new Error("legacy URL/token required");
  return async (metadata: IntakeMetadata, path: string): Promise<void> => {
    await assertLegacyInline(metadata, path);
    const body = legacyBodyMetadata(metadata);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
    let response: Response | undefined;
    try {
      response = await (options.fetch ?? fetch)(`${options.url.replace(/\/+$/u, "")}/api/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: inlineBody(body, path),
        signal: controller.signal,
      });
      if (response.status !== 202) throw new Error(`legacy HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => undefined);
    }
  };
}
