import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  AUTOMATION_MESSAGE,
  classifyFailure,
  createImsgExec,
  FDA_MESSAGE,
  ImsgError,
  imsgVersion,
  isPermissionFailure,
  KILLED_MESSAGE,
  parseNdjson,
  resolveImsgBin,
  runImsgJson,
  toErrorText,
  truncateMessageTexts,
  truncateText,
  TRUNCATION_MARKER,
} from "./imsg-cli.ts";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-imsg.sh", import.meta.url));

describe("imsg cli wrapper", () => {
  test("parses NDJSON one object per line, tolerating noise", () => {
    expect(parseNdjson('{"a":1}\n\n{"b":2}\n')).toEqual({ rows: [{ a: 1 }, { b: 2 }], warnings: [] });
    expect(parseNdjson('note: hi\n{"a":1}\n{"b":')).toEqual({
      rows: [{ a: 1 }],
      warnings: ["imsg emitted a non-JSON line: note: hi", 'imsg emitted a non-JSON line: {"b":'],
    });
    expect(parseNdjson("")).toEqual({ rows: [], warnings: [] });
    expect(parseNdjson("\n  \n")).toEqual({ rows: [], warnings: [] });
    expect(() => parseNdjson("not json")).toThrow(ImsgError);
  });

  test("truncates long text with a marker", () => {
    const long = "x".repeat(5_000);
    const out = truncateText(long);
    expect(out.length).toBe(4_000 + TRUNCATION_MARKER.length);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(truncateText("short")).toBe("short");
    expect(truncateMessageTexts([{ text: long }, { text: "ok" }, 5])).toEqual([
      { text: truncateText(long) },
      { text: "ok" },
      5,
    ]);
  });

  test("classifies permission failures", () => {
    expect(isPermissionFailure("authorization denied (code: 23)")).toBe(true);
    expect(isPermissionFailure("requires Full Disk Access")).toBe(true);
    expect(isPermissionFailure("boom")).toBe(false);
    expect(isPermissionFailure("Automation permission missing")).toBe(false);
    expect(classifyFailure("Not permitted to send Apple events to Messages. (-1743)")).toBe("automation");
    expect(classifyFailure("AppleScript error")).toBe("automation");
    expect(classifyFailure("Automation permission missing")).toBe("automation");
    expect(classifyFailure("error -1743")).toBe("automation");
    expect(classifyFailure("boom")).toBe("other");
    expect(toErrorText(new ImsgError("authorization denied", 1, "fda"))).toContain(FDA_MESSAGE);
    expect(toErrorText(new ImsgError("apple events", 1, "automation"))).toContain(AUTOMATION_MESSAGE);
    expect(toErrorText(new ImsgError("apple events", 1, "automation"))).not.toContain(FDA_MESSAGE);
    expect(toErrorText(new ImsgError("SIGTERM", null, "killed"))).toContain(KILLED_MESSAGE);
    expect(toErrorText(new ImsgError("boom", 3, "other"))).toBe("boom");
  });

  test("resolves binary from IMSG_MCP_BIN", () => {
    expect(resolveImsgBin({})).toBe("/opt/homebrew/bin/imsg");
    expect(resolveImsgBin({ IMSG_MCP_BIN: "/x/imsg" })).toBe("/x/imsg");
  });

  test("runs the fake binary and reports version", async () => {
    const exec = createImsgExec({ bin: FAKE });
    expect(await imsgVersion(exec)).toBe("0.15.4");
    const { rows } = await runImsgJson(exec, ["chats", "--limit", "2"]);
    expect(rows).toHaveLength(2);
  });

  test("non-JSON stdout lines become warnings; all-garbage throws", async () => {
    const exec = createImsgExec({ bin: FAKE });
    process.env.FAKE_IMSG_MODE = "noisy";
    try {
      const result = await runImsgJson(exec, ["chats"]);
      expect(result.rows).toHaveLength(2);
      expect(result.warnings).toEqual(["imsg emitted a non-JSON line: note: this is not json"]);
      process.env.FAKE_IMSG_MODE = "garbage";
      await expect(runImsgJson(exec, ["chats"])).rejects.toMatchObject({ failure: "other" });
    } finally {
      delete process.env.FAKE_IMSG_MODE;
    }
  });

  test("a killed child is classified as killed", async () => {
    const exec = createImsgExec({ bin: FAKE });
    process.env.FAKE_IMSG_MODE = "hang";
    try {
      await expect(runImsgJson(exec, ["send"], { timeoutMs: 200 })).rejects.toMatchObject({ failure: "killed" });
      const controller = new AbortController();
      const pending = runImsgJson(exec, ["send"], { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({ failure: "killed" });
    } finally {
      delete process.env.FAKE_IMSG_MODE;
    }
  });

  test("surfaces stderr on non-zero exit", async () => {
    const exec = createImsgExec({ bin: FAKE });
    process.env.FAKE_IMSG_MODE = "denied";
    try {
      await expect(runImsgJson(exec, ["chats"])).rejects.toMatchObject({ permission: true, failure: "fda", exitCode: 1 });
    } finally {
      delete process.env.FAKE_IMSG_MODE;
    }
    expect(await imsgVersion(createImsgExec({ bin: "/nonexistent/imsg" }))).toBeNull();
  });
});
