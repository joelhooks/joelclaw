import { describe, expect, test } from "bun:test";
import { buildDocsIngestEvent } from "./manifest-archive";

describe("manifest-archive docs queueing", () => {
  test("builds docs-ingest event for copied pdf entries", () => {
    const event = buildDocsIngestEvent(
      {
        id: "entry-001",
        filename: "Distributed-Systems.pdf",
        sourcePath: "/Users/joel/clawd/data/pdf-brain/incoming/Distributed-Systems.pdf",
        sourceExists: true,
        enrichmentCategory: "programming",
        enrichmentDocumentType: "book",
        sourceFileType: "pdf",
        sourceSizeBytes: 1234,
      },
      "copied",
    );

    expect(event).toBeTruthy();
    expect(event?.name).toBe("docs/ingest.requested");
    expect(event?.data.nasPath).toBe(
      "/Volumes/three-body/books/programming/Distributed-Systems.pdf",
    );
    expect(event?.data.storageCategory).toBe("programming");
    expect(event?.data.idempotencyKey).toBe("manifest:entry-001:copied");
  });

  test("skips unsupported file extensions", () => {
    const event = buildDocsIngestEvent(
      {
        id: "entry-epub",
        filename: "Systems-Design.epub",
        sourcePath: "/Users/joel/clawd/data/pdf-brain/incoming/Systems-Design.epub",
        sourceExists: true,
        enrichmentCategory: "design",
        enrichmentDocumentType: "book",
        sourceFileType: "epub",
        sourceSizeBytes: 2048,
      },
      "backfill",
    );

    expect(event).toBeNull();
  });
});
