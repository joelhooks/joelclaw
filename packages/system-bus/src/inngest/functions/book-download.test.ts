import { describe, expect, test } from "bun:test";
import {
  extractExistingPathFromOutput,
  parseInferenceSelection,
  parseSearchCandidates,
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
});
