import { inngest } from "../../client";
import { readPrd } from "./utils";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

type StoryDetail = {
  id: string;
  title: string;
  passed: boolean;
  skipped: boolean;
  attempts: number;
  tool: string;
};

type ToolRanking = {
  tool: string;
  passRate: number;
  avgAttempts: number;
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function buildRecommendations(storyDetails: StoryDetail[]): {
  toolRankings: ToolRanking[];
  retryPatterns: string[];
  suggestedRetryLadder: string[];
} {
  const byTool: Record<string, { total: number; passed: number; attempts: number }> = {};
  for (const s of storyDetails) {
    const tool = s.tool || "unknown";
    if (!byTool[tool]) byTool[tool] = { total: 0, passed: 0, attempts: 0 };
    byTool[tool].total += 1;
    byTool[tool].attempts += Math.max(1, s.attempts || 1);
    if (s.passed) byTool[tool].passed += 1;
  }

  const toolRankings = Object.entries(byTool)
    .map(([tool, stats]) => ({
      tool,
      passRate: stats.total > 0 ? Number((stats.passed / stats.total).toFixed(2)) : 0,
      avgAttempts: stats.total > 0 ? Number((stats.attempts / stats.total).toFixed(2)) : 0,
    }))
    .sort((a, b) => {
      if (b.passRate !== a.passRate) return b.passRate - a.passRate;
      return a.avgAttempts - b.avgAttempts;
    });

  const retryPatterns: string[] = [];
  const retryStories = storyDetails.filter((s) => s.attempts > 1);
  const skippedStories = storyDetails.filter((s) => s.skipped);

  if (retryStories.length > 0) {
    retryPatterns.push(
      `${retryStories.length} story(ies) needed retries (attempts > 1); high-complexity changes should get early review checkpoints.`
    );
  }
  if (skippedStories.length > 0) {
    retryPatterns.push(
      `${skippedStories.length} story(ies) ended skipped; add stricter decomposition and narrower acceptance slices on next loop.`
    );
  }
  if (retryPatterns.length === 0) {
    retryPatterns.push("No consistent retry risk patterns observed in this loop.");
  }

  const suggestedRetryLadder = toolRankings
    .filter((t) => t.tool !== "unknown")
    .map((t) => t.tool)
    .slice(0, 3);
  if (suggestedRetryLadder.length === 0) {
    suggestedRetryLadder.push("codex", "claude", "pi");
  }

  return { toolRankings, retryPatterns, suggestedRetryLadder };
}

function buildRetroMarkdown(input: {
  loopId: string;
  project: string;
  summary: string;
  storiesCompleted: number;
  storiesFailed: number;
  storiesSkipped: number;
  storyDetails: StoryDetail[];
  codebasePatterns: string;
}): string {
  const {
    loopId,
    project,
    summary,
    storiesCompleted,
    storiesFailed,
    storiesSkipped,
    storyDetails,
    codebasePatterns,
  } = input;

  const date = new Date().toISOString();
  const worked = storyDetails.filter((s) => s.passed && s.attempts <= 1);
  const struggled = storyDetails.filter((s) => s.skipped || s.attempts > 1 || !s.passed);

  const recommendations: string[] = [];
  if (struggled.length === 0) {
    recommendations.push("Maintain current implementation/review tool split for next loop.");
  } else {
    recommendations.push("Prioritize stories with prior retries for earlier human review checkpoints.");
    recommendations.push("Use strongest-performing tool from first-pass stories as default implementor.");
  }

  const rows = storyDetails
    .map((s) => {
      const result = s.passed ? "pass" : s.skipped ? "skip" : "fail";
      return `| ${escapeCell(s.id)} | ${escapeCell(s.title)} | ${result} | ${s.attempts} | ${escapeCell(s.tool)} |`;
    })
    .join("\n");

  return [
    "---",
    `loopId: ${loopId}`,
    `project: ${project}`,
    `date: ${date}`,
    `storiesCompleted: ${storiesCompleted}`,
    `storiesFailed: ${storiesFailed}`,
    `storiesSkipped: ${storiesSkipped}`,
    "---",
    "",
    "## Summary",
    summary || "No summary provided.",
    "",
    "## Story Outcomes",
    "",
    "| id | title | result | attempts | tool |",
    "| --- | --- | --- | --- | --- |",
    rows || "| - | - | - | - | - |",
    "",
    "## Codebase Patterns",
    codebasePatterns || "No codebase patterns found in progress.txt.",
    "",
    "## What Worked",
    worked.length > 0
      ? worked.map((s) => `- ${s.id} passed on first attempt with ${s.tool}.`).join("\n")
      : "- No stories passed on first attempt.",
    "",
    "## What Struggled",
    struggled.length > 0
      ? struggled
          .map((s) => {
            const state = s.skipped ? "skipped" : s.passed ? "needed retries" : "failed";
            return `- ${s.id} ${state} after ${s.attempts} attempt(s).`;
          })
          .join("\n")
      : "- No recurring struggles detected.",
    "",
    "## Recommendations",
    recommendations.map((r) => `- ${r}`).join("\n"),
    "",
  ].join("\n");
}

function extractCodebasePatterns(progressText: string): string {
  if (!progressText) return "";
  const marker = "## Codebase Patterns";
  const idx = progressText.indexOf(marker);
  if (idx === -1) return "";
  const rest = progressText.slice(idx);
  const nextHeading = rest.indexOf("\n## ", marker.length);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section.trim();
}

function parseStoryDetails(
  progressText: string,
  prdStories: Array<{ id?: string; title?: string; passes?: boolean }>
): StoryDetail[] {
  const lines = progressText.split("\n");
  const byId: Record<string, Partial<StoryDetail>> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    const m = line.match(
      /^\*\*Story\s+([^:]+):\s+(.+?)\*\*\s+—\s+(PASSED|FAILED|RECHECK PASS|RECHECK STILL FAILING)(?:\s+\(attempt\s+(\d+)\))?/i
    );
    if (!m) continue;

    const storyId = m[1]?.trim();
    const storyTitle = m[2]?.trim();
    if (!storyId) continue;
    const outcome = (m[3] ?? "").toUpperCase();
    const attempt = parseInt(m[4] ?? "1", 10);

    let tool = byId[storyId]?.tool ?? "unknown";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const toolMatch = (lines[j] ?? "").trim().match(/^- Tool:\s+(.+)$/i);
      if (toolMatch?.[1]) {
        tool = toolMatch[1].trim();
        break;
      }
    }

    const passed = outcome === "PASSED" || outcome === "RECHECK PASS";
    const skipped = outcome === "FAILED" || outcome === "RECHECK STILL FAILING";
    const priorAttempts = byId[storyId]?.attempts ?? 0;

    byId[storyId] = {
      id: storyId,
      title: storyTitle,
      passed: (byId[storyId]?.passed ?? false) || passed,
      skipped: skipped || (byId[storyId]?.skipped ?? false),
      attempts: Math.max(priorAttempts, Number.isNaN(attempt) ? 1 : attempt),
      tool,
    };
  }

  return prdStories
    .filter((s) => Boolean(s.id))
    .map((s) => {
    const storyId = s.id as string;
    const parsed = byId[storyId];
    return {
      id: storyId,
      title: s.title ?? storyId,
      passed: Boolean(parsed?.passed ?? s.passes ?? false),
      skipped: Boolean(parsed?.skipped ?? false),
      attempts: parsed?.attempts ?? 1,
      tool: parsed?.tool ?? "unknown",
    };
  });
}

export const agentLoopRetro = inngest.createFunction(
  {
    id: "agent-loop-retro",
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
    retries: 1,
  },
  [{ event: "agent/loop.complete" }],
  async ({ event, step }) => {
    const {
      loopId,
      project,
      summary,
      storiesCompleted,
      storiesFailed,
      cancelled,
      branchName,
    } = event.data;

    const progressText = await step.run("read-progress", async () => {
      try {
        return await Bun.file(`${project}/progress.txt`).text();
      } catch {
        return "";
      }
    });

    const prd = await step.run("read-prd", () => readPrd(project, "prd.json", loopId));
    const storyDetails = parseStoryDetails(progressText, prd.stories);
    const storiesSkipped = prd.stories.filter((s: any) => Boolean(s.skipped)).length;
    const codebasePatterns = extractCodebasePatterns(progressText);
    const totalAttempts = storyDetails.reduce((acc, s) => acc + (s.attempts || 0), 0);
    const totalDurationEstimate = totalAttempts * 15;

    const retrospective = {
      loopId,
      project,
      summary,
      storiesCompleted,
      storiesFailed,
      storiesSkipped,
      cancelled,
      branchName,
      storyDetails,
      codebasePatterns,
      totalDurationEstimate,
    };

    await step.run("write-retrospective-note", async () => {
      const vaultPath = process.env.VAULT_PATH ?? `${process.env.HOME}/Vault`;
      const retroDir = join(vaultPath, "system", "retrospectives");
      mkdirSync(retroDir, { recursive: true });
      const retroPath = join(retroDir, `${loopId}.md`);
      const markdown = buildRetroMarkdown({
        loopId,
        project,
        summary,
        storiesCompleted,
        storiesFailed,
        storiesSkipped,
        storyDetails,
        codebasePatterns,
      });
      await Bun.write(retroPath, markdown);
      return retroPath;
    });

    await step.run("write-planner-recommendations", async () => {
      const recommendations = buildRecommendations(storyDetails);
      const payload = {
        ...recommendations,
        lastUpdated: new Date().toISOString(),
        sourceLoopId: loopId,
      };
      const recommendationsPath = join(project, ".agent-loop-recommendations.json");
      await Bun.write(recommendationsPath, JSON.stringify(payload, null, 2) + "\n");
      return recommendationsPath;
    });

    await step.run("emit-retro-complete", async () => {
      await inngest.send({
        name: "agent/loop.retro.complete",
        data: {
          loopId,
          project,
          retrospective,
        },
      });
    });

    return {
      status: "retro-complete",
      loopId,
      storiesCompleted,
      storiesFailed,
      storiesSkipped,
    };
  }
);
