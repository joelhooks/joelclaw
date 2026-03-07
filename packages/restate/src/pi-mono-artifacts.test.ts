import { describe, expect, it } from "bun:test";
import { __piMonoArtifactsTestUtils } from "./pi-mono-artifacts";

describe("pi-mono artifact helpers", () => {
  it("extracts package scopes from labels, title scope, and file path", () => {
    const scopes = __piMonoArtifactsTestUtils.extractPackageScopes({
      title: "fix(coding-agent): prevent stale compaction usage",
      path: "packages/coding-agent/src/core/agent-session.ts",
      labels: ["bug", "pkg:agent"],
    });

    expect(scopes).toEqual(["agent", "coding-agent"]);
  });

  it("infers maintainer review tags from terse review language", () => {
    const tags = __piMonoArtifactsTestUtils.inferDecisionTags(
      "Breaks TUI. No dynamic imports. please reopen the issue with concrete steps to reproduce.",
    );

    expect(tags).toContain("tui_breakage");
    expect(tags).toContain("needs_repro");
  });

  it("builds a maintainer profile doc from imported artifacts", () => {
    const doc = __piMonoArtifactsTestUtils.buildMaintainerProfileDoc("badlogic/pi-mono", "badlogic", [
      {
        id: "1",
        repo: "badlogic/pi-mono",
        kind: "issue_comment",
        title: "Issue #1899 comment by badlogic",
        content: "which provider/model triggered this?",
        url: "https://github.com/badlogic/pi-mono/issues/1899#issuecomment-1",
        author: "badlogic",
        maintainer_signal: true,
        decision_tags: ["needs_repro", "provider_boundary"],
        package_scopes: ["agent"],
        created_at: Date.now(),
      },
      {
        id: "2",
        repo: "badlogic/pi-mono",
        kind: "pull_request_review_comment",
        title: "PR #492 review comment by badlogic",
        content: "Breaks TUI.",
        url: "https://github.com/badlogic/pi-mono/pull/492#discussion_r1",
        author: "badlogic",
        maintainer_signal: true,
        decision_tags: ["tui_breakage"],
        package_scopes: ["coding-agent"],
        created_at: Date.now(),
      },
    ]);

    expect(doc.kind).toBe("maintainer_profile");
    expect(doc.title).toContain("badlogic");
    expect(doc.content).toContain("needs_repro");
    expect(doc.content).toContain("coding-agent");
  });
});
