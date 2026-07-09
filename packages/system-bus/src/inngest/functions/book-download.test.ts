import { describe, expect, test } from "bun:test";
import {
  extractExistingPathFromOutput,
  hasFastPartnerAvailability,
  isConvertibleEbookExtension,
  parseInferenceSelection,
  parseSearchCandidates,
  selectVerifiedCandidate,
} from "./book-download";

describe("book-download helpers", () => {
  test("parseSearchCandidates extracts md5/title/format and deduplicates", () => {
    const output = [
      "\u001b[0;32m[10:01:01]\u001b[0m Searching: designing data intensive applications",
      "0123456789abcdef0123456789abcdef  \u001b[32mpdf\u001b[0m      12.5 MB  Designing Data-Intensive Applications",
      "fedcba9876543210fedcba9876543210  \u001b[33mepub\u001b[0m      10.0 MB  Designing Data-Intensive Applications",
      "0123456789abcdef0123456789abcdef  pdf      12.5 MB  Duplicate entry ignored",
      "Usage: aa-book add <md5> \"reason\"",
    ].join("\n");

    const candidates = parseSearchCandidates(output);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      md5: "0123456789abcdef0123456789abcdef",
      format: "pdf",
    });
    expect(candidates[1]).toMatchObject({
      md5: "fedcba9876543210fedcba9876543210",
      format: "epub",
    });
  });

  test("parseInferenceSelection handles json and plain-text fallbacks", () => {
    const jsonResult = parseInferenceSelection(
      '{"md5":"0123456789abcdef0123456789abcdef","reason":"Best match","confidence":0.92}'
    );
    expect(jsonResult).toMatchObject({
      md5: "0123456789abcdef0123456789abcdef",
      reason: "Best match",
      confidence: 0.92,
    });

    const textResult = parseInferenceSelection(
      "I recommend md5 fedcba9876543210fedcba9876543210 for the requested title."
    );
    expect(textResult).toMatchObject({
      md5: "fedcba9876543210fedcba9876543210",
    });
  });

  test("extractExistingPathFromOutput returns trailing download path", () => {
    const output = [
      "[STATUS] Downloading md5: 0123456789abcdef0123456789abcdef",
      "\u001b[0;32m[10:02:03]\u001b[0m Saving as: ddia.pdf",
      "/Users/joel/clawd/data/pdf-brain/incoming/ddia.pdf",
    ].join("\n");

    expect(extractExistingPathFromOutput(output)).toBe(
      "/Users/joel/clawd/data/pdf-brain/incoming/ddia.pdf"
    );
  });

  test("isConvertibleEbookExtension covers azw3, fb2, epub, mobi but not pdf/djvu", () => {
    expect(isConvertibleEbookExtension("azw3")).toBe(true);
    expect(isConvertibleEbookExtension("AZW3")).toBe(true);
    expect(isConvertibleEbookExtension("fb2")).toBe(true);
    expect(isConvertibleEbookExtension("epub")).toBe(true);
    expect(isConvertibleEbookExtension("mobi")).toBe(true);
    expect(isConvertibleEbookExtension("pdf")).toBe(false);
    expect(isConvertibleEbookExtension("djvu")).toBe(false);
    expect(isConvertibleEbookExtension("zip")).toBe(false);
  });

  test("hasFastPartnerAvailability detects a fast_download link or the label text", () => {
    expect(hasFastPartnerAvailability('<a href="/fast_download/abc123/0/0">Fast Partner Server #1</a>')).toBe(
      true
    );
    expect(hasFastPartnerAvailability("Some page mentioning Fast Partner Server availability")).toBe(true);
    expect(hasFastPartnerAvailability("<p>Only libgen / slow partner mirrors available</p>")).toBe(false);
    expect(hasFastPartnerAvailability("")).toBe(false);
  });

  test("selectVerifiedCandidate picks the inferred md5 when it verifies", async () => {
    const candidates = [
      { md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Book A", format: "pdf", line: "" },
      { md5: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", title: "Book B", format: "epub", line: "" },
    ];

    const result = await selectVerifiedCandidate({
      candidates,
      inferredMd5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      maxAttempts: 6,
      verify: async (md5) => ({ available: true, reason: `${md5} ok` }),
    });

    expect(result.picked?.origin).toBe("inference");
    expect(result.picked?.candidate.md5).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.attempts).toHaveLength(1);
  });

  test("selectVerifiedCandidate falls through to the next candidate when the inferred md5 has no fast partner", async () => {
    // Mirrors the real failure: a libgen-only md5 (no fast partner tier)
    // should not abort the run — the next candidate should be tried.
    const candidates = [
      { md5: "73f92aaf4bb0848cd3ea801744f0298a", title: "Great Leads (libgen only)", format: "pdf", line: "" },
      { md5: "992e9ea8d28acaab2a48e5dbeb560bff", title: "Great Leads (fast partner)", format: "pdf", line: "" },
    ];

    const result = await selectVerifiedCandidate({
      candidates,
      inferredMd5: "73f92aaf4bb0848cd3ea801744f0298a",
      maxAttempts: 6,
      verify: async (md5) => {
        if (md5 === "73f92aaf4bb0848cd3ea801744f0298a") {
          return { available: false, reason: "no fast partner server link found (libgen-only)" };
        }
        return { available: true, reason: "fast partner server link present" };
      },
    });

    expect(result.picked?.origin).toBe("fallback");
    expect(result.picked?.candidate.md5).toBe("992e9ea8d28acaab2a48e5dbeb560bff");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ available: false });
    expect(result.attempts[1]).toMatchObject({ available: true });
  });

  test("selectVerifiedCandidate returns no pick when every candidate fails verification", async () => {
    const candidates = [
      { md5: "cccccccccccccccccccccccccccccccc".slice(0, 32), title: "Book C", format: "pdf", line: "" },
    ];

    const result = await selectVerifiedCandidate({
      candidates,
      inferredMd5: null,
      maxAttempts: 6,
      verify: async () => ({ available: false, reason: "no fast partner server link found" }),
    });

    expect(result.picked).toBeNull();
    expect(result.attempts).toHaveLength(1);
  });

  test("selectVerifiedCandidate caps attempts at maxAttempts", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      md5: `${i}`.padStart(32, "0"),
      title: `Book ${i}`,
      format: "pdf",
      line: "",
    }));

    let calls = 0;
    const result = await selectVerifiedCandidate({
      candidates,
      inferredMd5: null,
      maxAttempts: 3,
      verify: async () => {
        calls += 1;
        return { available: false, reason: "no fast partner" };
      },
    });

    expect(result.picked).toBeNull();
    expect(calls).toBe(3);
    expect(result.attempts).toHaveLength(3);
  });
});
