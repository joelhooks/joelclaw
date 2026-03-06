import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_AUTONOMOUS_TOOL_BUDGET,
  buildDeployVerificationPlan,
  CHANNEL_AUTONOMOUS_TOOL_BUDGET,
  extractBashCommand,
  extractRepoPathFromCommand,
  guardrailToolBudgetForSource,
  isGitPushCommand,
  shouldTriggerToolBudgetCheckpoint,
  shouldVerifyDeploy,
  summarizeToolNames,
} from "./guardrails";

describe("gateway guardrail helpers", () => {
  test("extracts bash command payloads from tool input", () => {
    expect(extractBashCommand({ command: "git push" })).toBe("git push");
    expect(extractBashCommand({})).toBeUndefined();
    expect(extractBashCommand(null)).toBeUndefined();
  });

  test("detects git push commands", () => {
    expect(isGitPushCommand("git push")).toBe(true);
    expect(isGitPushCommand("cd ~/Code/joelhooks/joelclaw && git push origin main")).toBe(true);
    expect(isGitPushCommand("git status && git commit -m test")).toBe(false);
  });

  test("extracts repo path from cd + git push command", () => {
    expect(
      extractRepoPathFromCommand(
        "cd ~/Code/joelhooks/joelclaw && git push origin main",
        "/Users/joel",
      ),
    ).toBe("/Users/joel/Code/joelhooks/joelclaw");
  });

  test("extracts repo path from git -C push command", () => {
    expect(
      extractRepoPathFromCommand(
        'git -C "/Users/joel/Code/joelhooks/joelclaw" push origin main',
        "/Users/joel",
      ),
    ).toBe("/Users/joel/Code/joelhooks/joelclaw");
  });

  test("only requires deploy verification for apps/web or root config changes", () => {
    expect(shouldVerifyDeploy(["apps/web/app/page.tsx"])).toBe(true);
    expect(shouldVerifyDeploy(["package.json"])).toBe(true);
    expect(shouldVerifyDeploy(["packages/gateway/src/daemon.ts"])).toBe(false);
  });

  test("builds a deploy verification plan only when required", () => {
    expect(
      buildDeployVerificationPlan("/Users/joel/Code/joelhooks/joelclaw", ["apps/web/app/page.tsx"]),
    ).toEqual({
      repoPath: "/Users/joel/Code/joelhooks/joelclaw",
      changedFiles: ["apps/web/app/page.tsx"],
    });
    expect(
      buildDeployVerificationPlan("/Users/joel/Code/joelhooks/joelclaw", ["packages/gateway/src/daemon.ts"]),
    ).toBeUndefined();
  });

  test("uses stricter budget for channel turns than background turns", () => {
    expect(guardrailToolBudgetForSource("channel")).toBe(CHANNEL_AUTONOMOUS_TOOL_BUDGET);
    expect(guardrailToolBudgetForSource("internal")).toBe(BACKGROUND_AUTONOMOUS_TOOL_BUDGET);
    expect(shouldTriggerToolBudgetCheckpoint(3, "channel")).toBe(true);
    expect(shouldTriggerToolBudgetCheckpoint(3, "internal")).toBe(false);
    expect(shouldTriggerToolBudgetCheckpoint(5, "internal")).toBe(true);
  });

  test("summarizes recent tool names compactly", () => {
    expect(summarizeToolNames(["read", "bash", "write"])).toBe("read → bash → write");
    expect(summarizeToolNames(["read", "bash", "write", "edit", "bash"])).toBe(
      "read → bash → write → edit (+1)",
    );
  });
});
