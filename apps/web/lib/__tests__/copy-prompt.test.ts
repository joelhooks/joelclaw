import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildCopyPrompt } from "../copy-prompt";

describe("buildCopyPrompt", () => {
  test("uses operator-facing lead line and canonical .md URL", () => {
    const output = buildCopyPrompt({
      title: "joelclaw is a claw-like organism",
      slug: "joelclaw-is-a-claw-like-organism",
      description: "A specimen report on personal AI infrastructure as biological organism.",
    });

    assert.match(output, /^Explain this to your operator: https:\/\/joelclaw\.com\/joelclaw-is-a-claw-like-organism\.md/m);
    assert.ok(!output.includes("Read this spec and build it:"));
    assert.ok(!output.includes("/md\n"));
  });

  test("normalizes legacy slug forms to canonical .md URL", () => {
    const fromLegacyRoute = buildCopyPrompt({ title: "t", slug: "joelclaw-is-a-claw-like-organism/md" });
    const fromMdSuffix = buildCopyPrompt({ title: "t", slug: "joelclaw-is-a-claw-like-organism.md" });
    const fromSlashed = buildCopyPrompt({ title: "t", slug: "/joelclaw-is-a-claw-like-organism/" });

    const expected = "https://joelclaw.com/joelclaw-is-a-claw-like-organism.md";
    assert.ok(fromLegacyRoute.includes(expected));
    assert.ok(fromMdSuffix.includes(expected));
    assert.ok(fromSlashed.includes(expected));
  });

  test("includes summary only when description has content", () => {
    const withSummary = buildCopyPrompt({ title: "t", slug: "x", description: "  hello  " });
    const withoutSummary = buildCopyPrompt({ title: "t", slug: "x", description: "   " });

    assert.ok(withSummary.includes("Summary: hello"));
    assert.ok(!withoutSummary.includes("Summary:"));
  });
});
