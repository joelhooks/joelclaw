import { describe, expect, test } from "bun:test";
import {
  docsReadinessReasons,
  isArtifactSourceUnavailable,
  isValidArtifactDocId,
} from "./readiness";

describe("artifact document ids", () => {
  test("accepts the stored document id grammar", () => {
    expect(isValidArtifactDocId("programming-rust-2nd-edition-ae82030ba4e9")).toBe(true);
  });

  test.each([
    "",
    "../escape",
    "doc/name",
    "doc\\name",
    "doc;touch-pwned",
    "doc$(touch-pwned)",
    "doc`touch-pwned`",
    "doc name",
    " valid-id",
    "valid-id ",
    "doc\nname",
    "doc'name",
    'doc"name',
    "-leading",
    "trailing-",
  ])("rejects unsafe id %p", (value) => {
    expect(isValidArtifactDocId(value)).toBe(false);
  });
});

describe("artifact source failures", () => {
  test.each(["ENOENT", "EIO", "ENOTCONN", "ESTALE", "ETIMEDOUT"])(
    "treats %s as a fallback condition",
    (code) => {
      const error = Object.assign(new Error(code), { code });
      expect(isArtifactSourceUnavailable(error)).toBe(true);
    },
  );

  test("keeps permission errors hard", () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(isArtifactSourceUnavailable(error)).toBe(false);
  });
});

describe("docs readiness", () => {
  test("is ready only when every required read surface is available", () => {
    expect(
      docsReadinessReasons({
        typesenseOk: true,
        docsCount: 662,
        chunksCount: 241_939,
        artifactsAvailable: true,
      }),
    ).toEqual([]);
  });

  test("reports every unavailable dependency", () => {
    expect(
      docsReadinessReasons({
        typesenseOk: false,
        docsCount: 0,
        chunksCount: 0,
        artifactsAvailable: false,
      }),
    ).toEqual([
      "typesense_unavailable",
      "docs_collection_empty",
      "chunks_collection_empty",
      "artifacts_unavailable",
    ]);
  });
});
