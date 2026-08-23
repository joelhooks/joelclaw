/**
 * `recall-compare` argument and output safety.
 *
 * The receipt path can be anything `--out` accepted, and the case ID can be
 * anything a caller typed. Both end up in text a human copies into a shell or
 * a file that is meant to hold no bodies, so both are checked here.
 */

import { describe, expect, test } from "bun:test";
import { isValidCaseId } from "../recall/comparison";
import { shellQuote } from "./recall-compare";

describe("next-action quoting", () => {
  test("wraps an ordinary path in single quotes", () => {
    expect(shellQuote("/Users/joel/.joelclaw/receipts/a.json")).toBe(
      "'/Users/joel/.joelclaw/receipts/a.json'",
    );
  });

  test("neutralises a path that would otherwise run a command", () => {
    const hostile = "/tmp/a; rm -rf ~/.joelclaw #.json";
    const quoted = shellQuote(hostile);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // The whole hostile string sits inside one quoted word, so `;` and `#`
    // are literal characters rather than a command separator and a comment.
    expect(quoted.slice(1, -1)).toBe(hostile);
    expect(quoted.split("'").length - 1).toBe(2);
  });

  test("escapes an embedded single quote by closing and reopening", () => {
    expect(shellQuote("/tmp/joel's receipts/a.json")).toBe(
      "'/tmp/joel'\\''s receipts/a.json'",
    );
  });

  test("quotes command substitution and variable expansion inertly", () => {
    for (const hostile of ["/tmp/$(id).json", "/tmp/`id`.json", "/tmp/$HOME.json"]) {
      expect(shellQuote(hostile)).toBe(`'${hostile}'`);
    }
  });
});

describe("case ID validation at the command boundary", () => {
  test("accepts a short opaque label", () => {
    expect(isValidCaseId("recall-2026-08-22.a_1")).toBe(true);
  });

  test("refuses a question, a path, and an over-long label", () => {
    expect(isValidCaseId("what did we decide about postgres?")).toBe(false);
    expect(isValidCaseId("/Users/joel/.joelclaw/critical.db")).toBe(false);
    expect(isValidCaseId("a".repeat(65))).toBe(false);
  });
});
