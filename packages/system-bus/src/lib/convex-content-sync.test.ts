import { describe, expect, test } from "bun:test";
import { parseAdrMatter, stripLeadingFrontmatterBlock } from "./convex-content-sync";

describe("stripLeadingFrontmatterBlock", () => {
  test("removes a valid leading frontmatter block", () => {
    const raw = [
      "---",
      "title: Example",
      "status: proposed",
      "---",
      "# ADR-0001: Example",
      "Body",
    ].join("\n");

    expect(stripLeadingFrontmatterBlock(raw)).toBe("# ADR-0001: Example\nBody");
  });

  test("returns raw input when no frontmatter block exists", () => {
    const raw = "# ADR-0001: Example\nBody";
    expect(stripLeadingFrontmatterBlock(raw)).toBe(raw);
  });
});

describe("parseAdrMatter", () => {
  test("parses valid frontmatter", () => {
    const raw = [
      "---",
      "title: Workflow Runtime Deployment Strategy",
      "status: proposed",
      "---",
      "# ADR-0201: Workflow Runtime Deployment Strategy",
      "Body",
    ].join("\n");

    const parsed = parseAdrMatter(raw);

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.data.title).toBe("Workflow Runtime Deployment Strategy");
    expect(parsed.content.startsWith("# ADR-0201")).toBeTrue();
  });

  test("falls back to body-only parse when frontmatter is malformed", () => {
    const raw = [
      "---",
      "title: [broken",
      "status: proposed",
      "---",
      "# ADR-0201: Workflow Runtime Deployment Strategy",
      "Body",
    ].join("\n");

    const parsed = parseAdrMatter(raw);

    expect(parsed.parseError).toBeDefined();
    expect(parsed.data).toEqual({});
    expect(parsed.content.startsWith("# ADR-0201")).toBeTrue();
    expect(parsed.content.includes("---")).toBeFalse();
  });
});
