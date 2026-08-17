import { describe, expect, test } from "bun:test";
import { __docsTestUtils } from "./docs";

const {
  buildDocsSearchParams,
  docsStatusReady,
  formatDocsVectorQuery,
  isLocalArtifactSourceUnavailable,
  normalizeDocsApiToken,
} = __docsTestUtils;

describe("docs API token resolution", () => {
  test("accepts a raw leased token", () => {
    expect(normalizeDocsApiToken("abcdefghijklmnop\n")).toBe("abcdefghijklmnop");
  });

  test("rejects structured or malformed lease output", () => {
    expect(normalizeDocsApiToken('{"ok":false}')).toBeNull();
    expect(normalizeDocsApiToken("short")).toBeNull();
    expect(normalizeDocsApiToken("token with spaces")).toBeNull();
  });
});

describe("docs status readiness", () => {
  test("requires collections and artifacts", () => {
    expect(docsStatusReady(662, 241_939, true)).toBe(true);
    expect(docsStatusReady(662, 241_939, false)).toBe(false);
    expect(docsStatusReady(0, 241_939, true)).toBe(false);
    expect(docsStatusReady(662, 0, true)).toBe(false);
  });
});

describe("local artifact fallback", () => {
  test.each(["ENOENT", "EIO", "ENOTCONN", "ESTALE", "ETIMEDOUT"])("falls back after %s", (code) => {
    const error = Object.assign(new Error(code), { code });
    expect(isLocalArtifactSourceUnavailable(error)).toBe(true);
  });

  test("keeps permission failures hard", () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(isLocalArtifactSourceUnavailable(error)).toBe(false);
  });
});

describe("docs semantic search", () => {
  test("uses vector_query without putting raw embedding in query_by", () => {
    const params = buildDocsSearchParams("distributed systems", 10, [0.1, -0.2, Number.NaN]);

    expect(params.get("query_by")).toBe("retrieval_text,content");
    expect(params.get("query_by")).not.toContain("embedding");
    expect(params.get("vector_query")).toBe("embedding:([0.1,-0.2,0], k:30, alpha:0.75)");
  });

  test("falls back to lexical search when no query embedding is available", () => {
    const params = buildDocsSearchParams("distributed systems", 5);

    expect(params.get("query_by")).toBe("retrieval_text,content");
    expect(params.has("vector_query")).toBe(false);
  });

  test("enforces the minimum semantic fetch size", () => {
    expect(formatDocsVectorQuery([0.25], 20)).toBe("embedding:([0.25], k:20, alpha:0.75)");
  });
});
