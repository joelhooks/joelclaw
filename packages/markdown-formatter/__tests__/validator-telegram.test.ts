import { describe, expect, test } from "vitest";
import { validateTelegramHtml } from "../src";

function generateTagBlocks(count: number): string {
  return Array.from({ length: count }, () => "<b>x</b>").join("");
}

describe("validateTelegramHtml", () => {
  test("valid Telegram HTML passes with no errors", () => {
    const html = `
      <b>bold</b>
      <i>italic</i>
      <u>underline</u>
      <s>strike</s>
      <code>code</code>
      <pre><code>const x = 1;</code></pre>
      <a href="https://example.com">link</a>
      <blockquote>quote</blockquote>
      <tg-spoiler>secret</tg-spoiler>
    `;
    const result = validateTelegramHtml(html);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("unsupported tag <div> raises an error", () => {
    const result = validateTelegramHtml("<div>nope</div>");
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.rule === "no-unsupported-tags")).toBe(true);
  });

  test("unbalanced <b>text missing close raises an error", () => {
    const result = validateTelegramHtml("<b>text");
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.rule === "balanced-tags")).toBe(true);
  });

  test("nested <pre> inside <blockquote> raises an error", () => {
    const result = validateTelegramHtml("<blockquote><pre>bad</pre></blockquote>");
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.rule === "no-nested-pre")).toBe(true);
  });

  test("nested <a> inside <a> raises an error", () => {
    const result = validateTelegramHtml('<a href="https://outer.com"><a href="https://inner.com">bad</a></a>');
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.rule === "no-nested-links")).toBe(true);
  });

  test("message longer than 4096 chars raises an error", () => {
    const result = validateTelegramHtml("x".repeat(4097));
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.rule === "max-length")).toBe(true);
  });

  test("telegram entity-count warnings and errors", () => {
    const warningResult = validateTelegramHtml(generateTagBlocks(81));
    expect(warningResult.valid).toBe(true);
    expect(warningResult.warnings.some((warning) => warning.rule === "entity-count")).toBe(true);
    expect(warningResult.errors.some((error) => error.rule === "entity-count")).toBe(false);

    const errorResult = validateTelegramHtml(generateTagBlocks(101));
    expect(errorResult.valid).toBe(false);
    expect(errorResult.errors.some((error) => error.rule === "entity-count")).toBe(true);
  });

  test("empty supported tag raises warning", () => {
    const result = validateTelegramHtml("<b></b>");
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.rule === "no-empty-tags")).toBe(true);
  });

  test("anchor without href raises warning", () => {
    const result = validateTelegramHtml("<a>missing href</a>");
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.rule === "valid-href")).toBe(true);
  });

  test("bare ampersand raises warning", () => {
    const result = validateTelegramHtml("Fish & chips");
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.rule === "ampersand-escape")).toBe(true);
  });

  test("complex valid message with all supported tag types passes", () => {
    const html = `
      <blockquote><b>quote</b></blockquote>
      <tg-spoiler>spoiler</tg-spoiler>
      <pre><code>return true;</code></pre>
      <a href="https://example.com">link</a>
      <b><i><u><s><code>stack</code></s></u></i></b>
    `;
    const result = validateTelegramHtml(html);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("empty string is valid", () => {
    const result = validateTelegramHtml("");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
