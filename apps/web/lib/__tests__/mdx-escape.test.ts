import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeMdxAngleBrackets } from "../mdx-escape";

describe("escapeMdxAngleBrackets", () => {
  test("escapes comparison angle brackets but preserves valid tags", () => {
    const input = [
      "Threshold is < 0.5 and >50% for <5MB payloads.",
      'Use <strong>bold</strong> and <MyComponent prop="x">ok</MyComponent>.',
    ].join("\n");

    const output = escapeMdxAngleBrackets(input);

    assert.equal(
      output,
      [
        "Threshold is &lt; 0.5 and &gt;50% for &lt;5MB payloads.",
        'Use <strong>bold</strong> and <MyComponent prop="x">ok</MyComponent>.',
      ].join("\n")
    );
  });

  test("preserves fenced and inline code", () => {
    const input = [
      "Outside < 1 and >2.",
      "`inline <code> > here`",
      "```ts",
      "const x = a < b && c > d;",
      "```",
      "After <3.",
    ].join("\n");

    const output = escapeMdxAngleBrackets(input);

    assert.equal(
      output,
      [
        "Outside &lt; 1 and &gt;2.",
        "`inline <code> > here`",
        "```ts",
        "const x = a < b && c > d;",
        "```",
        "After &lt;3.",
      ].join("\n")
    );
  });
});
