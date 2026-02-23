import { describe, expect, test } from "bun:test";
import { inngest, type Events } from "./client";

type SendEventArg = Parameters<typeof inngest.send>[0];

async function captureEvent(event: SendEventArg): Promise<SendEventArg> {
  return event;
}

describe("MEM-2 client event schema acceptance tests", () => {
  test("supports memory/proposal.approved with proposalId and approvedBy", async () => {
    const approvedData: Events["memory/proposal.approved"]["data"] = {
      proposalId: "p-20260217-001",
      approvedBy: "joel",
    };

    const result = await captureEvent({
      name: "memory/proposal.approved",
      data: approvedData,
    });

    expect(result).toMatchObject({
      name: "memory/proposal.approved",
      data: {
        proposalId: "p-20260217-001",
        approvedBy: "joel",
      },
    });
  });

  test("supports memory/proposal.rejected with proposalId, reason, and rejectedBy", async () => {
    const rejectedData: Events["memory/proposal.rejected"]["data"] = {
      proposalId: "p-20260217-002",
      reason: "Conflicts with an existing hard rule.",
      rejectedBy: "joel",
    };

    const result = await captureEvent({
      name: "memory/proposal.rejected",
      data: rejectedData,
    });

    expect(result).toMatchObject({
      name: "memory/proposal.rejected",
      data: {
        proposalId: "p-20260217-002",
        reason: "Conflicts with an existing hard rule.",
        rejectedBy: "joel",
      },
    });
  });

  test("supports docs/ingest.requested with docs metadata", async () => {
    const ingestData: Events["docs/ingest.requested"]["data"] = {
      nasPath: "/Volumes/three-body/books/programming/example.pdf",
      title: "Example Document",
      tags: ["programming", "ai"],
      storageCategory: "programming",
      sourceHost: "three-body",
      idempotencyKey: "docs-ingest:example",
    };

    const result = await captureEvent({
      name: "docs/ingest.requested",
      data: ingestData,
    });

    expect(result).toMatchObject({
      name: "docs/ingest.requested",
      data: {
        nasPath: "/Volumes/three-body/books/programming/example.pdf",
        title: "Example Document",
      },
    });
  });

  test("supports pipeline/book.download with inference controls", async () => {
    const bookRequest: Events["pipeline/book.download"]["data"] = {
      query: "designing data-intensive applications",
      format: "pdf",
      reason: "memory backfill",
      outputDir: "/Users/joel/clawd/data/pdf-brain/incoming",
      tags: ["books", "aa-book"],
      storageCategory: "programming",
      idempotencyKey: "book:ddia:request",
    };

    const result = await captureEvent({
      name: "pipeline/book.download",
      data: bookRequest,
    });

    expect(result).toMatchObject({
      name: "pipeline/book.download",
      data: {
        query: "designing data-intensive applications",
        format: "pdf",
        reason: "memory backfill",
      },
    });
  });

  test("supports pipeline/book.downloaded with selection metadata", async () => {
    const downloaded: Events["pipeline/book.downloaded"]["data"] = {
      title: "Designing Data-Intensive Applications",
      nasPath: "/Users/joel/clawd/data/pdf-brain/incoming/ddia.pdf",
      md5: "0123456789abcdef0123456789abcdef",
      query: "designing data-intensive applications",
      selectedBy: "inference",
      outputDir: "/Users/joel/clawd/data/pdf-brain/incoming",
      format: "pdf",
      tags: ["aa-book", "book"],
    };

    const result = await captureEvent({
      name: "pipeline/book.downloaded",
      data: downloaded,
    });

    expect(result).toMatchObject({
      name: "pipeline/book.downloaded",
      data: {
        title: "Designing Data-Intensive Applications",
        selectedBy: "inference",
        format: "pdf",
      },
    });
  });

  test("supports manifest/archive.requested docs queue controls", async () => {
    const archiveData: Events["manifest/archive.requested"]["data"] = {
      reason: "docs backlog catch-up",
      dryRun: false,
      queueDocsIngest: true,
      queueSkipped: true,
    };

    const result = await captureEvent({
      name: "manifest/archive.requested",
      data: archiveData,
    });

    expect(result).toMatchObject({
      name: "manifest/archive.requested",
      data: {
        reason: "docs backlog catch-up",
        dryRun: false,
        queueDocsIngest: true,
        queueSkipped: true,
      },
    });
  });

  test("supports system/health.requested slice mode metadata", async () => {
    const healthData: Events["system/health.requested"]["data"] = {
      mode: "signals",
      source: "system-health-signals-hourly",
    };

    const result = await captureEvent({
      name: "system/health.requested",
      data: healthData,
    });

    expect(result).toMatchObject({
      name: "system/health.requested",
      data: {
        mode: "signals",
        source: "system-health-signals-hourly",
      },
    });
  });

  test("supports docs/backlog.requested controls", async () => {
    const backlogData: Events["docs/backlog.requested"]["data"] = {
      booksOnly: true,
      onlyMissing: true,
      maxEntries: 100,
      idempotencyPrefix: "backfill",
    };

    const result = await captureEvent({
      name: "docs/backlog.requested",
      data: backlogData,
    });

    expect(result).toMatchObject({
      name: "docs/backlog.requested",
      data: {
        booksOnly: true,
        onlyMissing: true,
        maxEntries: 100,
      },
    });
  });

  test("supports docs/backlog.drive.requested queue gate overrides", async () => {
    const driverData: Events["docs/backlog.drive.requested"]["data"] = {
      reason: "manual catch-up",
      force: true,
      maxEntries: 48,
      maxRunning: 2,
      maxQueued: 18,
      lookbackHours: 6,
      booksOnly: true,
      onlyMissing: true,
    };

    const result = await captureEvent({
      name: "docs/backlog.drive.requested",
      data: driverData,
    });

    expect(result).toMatchObject({
      name: "docs/backlog.drive.requested",
      data: {
        reason: "manual catch-up",
        force: true,
        maxEntries: 48,
        maxRunning: 2,
        maxQueued: 18,
      },
    });
  });

  test("supports docs/ingest.janitor.requested controls", async () => {
    const janitorData: Events["docs/ingest.janitor.requested"]["data"] = {
      reason: "recover stalled finalization",
      lookbackHours: 12,
      scanLimit: 90,
      staleMinutes: 20,
      maxRecoveries: 5,
    };

    const result = await captureEvent({
      name: "docs/ingest.janitor.requested",
      data: janitorData,
    });

    expect(result).toMatchObject({
      name: "docs/ingest.janitor.requested",
      data: {
        reason: "recover stalled finalization",
        lookbackHours: 12,
        scanLimit: 90,
        staleMinutes: 20,
      },
    });
  });

  test("supports meeting/transcript.fetched for transcript indexing fanout", async () => {
    const transcriptFetched: Events["meeting/transcript.fetched"]["data"] = {
      meetingId: "meeting_123",
      title: "AI Hero planning sync",
      date: "2026-02-23T16:00:00.000Z",
      participants: ["Joel", "Amy"],
      source: "heartbeat",
      sourceUrl: "https://notes.granola.ai/d/meeting_123",
      transcript: "Joel: We should launch the new cohort next week.",
    };

    const result = await captureEvent({
      name: "meeting/transcript.fetched",
      data: transcriptFetched,
    });

    expect(result).toMatchObject({
      name: "meeting/transcript.fetched",
      data: {
        meetingId: "meeting_123",
        title: "AI Hero planning sync",
      },
    });
  });
});
