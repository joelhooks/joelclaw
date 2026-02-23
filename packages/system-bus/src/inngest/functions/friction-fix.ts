import { execSync } from "node:child_process";
import { join } from "node:path";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import type { TaskPort } from "../../tasks/port";
import { MODEL } from "../../lib/models";
import { inngest } from "../client";

const HOME_DIR = process.env.HOME || "/Users/joel";
const WORK_DIR = join(HOME_DIR, "Code", "joelhooks", "joelclaw");
const TODOIST_API = "https://api.todoist.com/api/v1";
const CODEX_TIMEOUT_MS = 600_000;

type FixStatus = "fixed" | "documented" | "skipped";

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runGit(command: string): string {
  return execSync(command, {
    cwd: WORK_DIR,
    encoding: "utf-8",
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function getTodoistToken(): string | undefined {
  return process.env.TODOIST_API_TOKEN;
}

async function addTodoistComment(taskId: string, content: string): Promise<void> {
  const token = getTodoistToken();
  if (!token) {
    throw new Error("TODOIST_API_TOKEN env var is required");
  }

  const response = await fetch(`${TODOIST_API}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      task_id: taskId,
      content,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Todoist comment failed (${response.status}): ${body.slice(0, 500)}`);
  }
}

function buildFixPrompt(
  branchName: string,
  title: string,
  summary: string,
  suggestion: string,
  evidence: string[]
): string {
  return `Fix a detected friction pattern in the joelclaw monorepo.

## Pattern

Title: ${title}
Problem: ${summary}
Suggested Fix: ${suggestion}

Evidence:
${evidence.map((e) => `- ${e}`).join("\n")}

## Instructions

1. Check out branch: ${branchName}
2. Implement the suggested fix — prefer a working code change over a TODO comment
3. Keep changes minimal and focused on the stated problem
4. Only modify files directly related to the fix
5. Run type checking: bunx tsc --noEmit
6. Commit with message: "friction-fix: ${title}"

Do not refactor unrelated code. Do not modify tests unless the fix requires it.
`;
}

export const frictionFix = inngest.createFunction(
  {
    id: "memory/friction-fix",
    name: "Auto-Fix Friction Pattern",
    concurrency: 1,
  },
  { event: "memory/friction.fix.requested" },
  async ({ event, step, gateway }) => {
    const { patternId, title, summary, suggestion, evidence, todoistTaskId } = event.data;
    const branchName = `friction-fix/${patternId.replace(/[^a-zA-Z0-9._/-]/g, "-")}`;

    await step.run("create-fix-branch", async () => {
      runGit("git checkout main");

      try {
        runGit(`git show-ref --verify --quiet refs/heads/${branchName}`);
        runGit(`git branch -D ${branchName}`);
      } catch {
        // Branch does not exist; continue.
      }

      runGit(`git checkout -b ${branchName}`);
      return { branchName };
    });

    const dispatch = await step.run("dispatch-fix-agent", async () => {
      const prompt = buildFixPrompt(branchName, title, summary, suggestion, evidence);
      const cmd = [
        "codex",
        "exec",
        "--model",
        MODEL.CODEX, // ADR-0084 — gpt-5.3-codex, never o3/o4-mini
        "--full-auto",
        shellEscapeSingleQuoted(prompt),
      ];

      try {
        const result = execSync(cmd.join(" "), {
          cwd: WORK_DIR,
          encoding: "utf-8",
          timeout: CODEX_TIMEOUT_MS,
          env: { ...process.env },
          maxBuffer: 10 * 1024 * 1024,
        });

        return {
          status: "completed" as const,
          output: result.trim().slice(-20_000),
        };
      } catch (error: any) {
        const stderr = error?.stderr?.toString().trim() || "";
        const stdout = error?.stdout?.toString().trim() || "";
        const message = error?.message || String(error);

        return {
          status: "failed" as const,
          output: stdout.slice(-10_000),
          error: (stderr || message).slice(-5_000),
        };
      }
    });

    let status: FixStatus = "skipped";
    let message = "No fix commit was created";
    let commitSha: string | undefined;
    let filesChanged: string[] = [];
    let escalationTaskId: string | undefined;

    if (dispatch.status === "failed") {
      status = "documented";
      message = `Fix agent failed: ${dispatch.error}`;
    } else {
      const verification = await step.run("verify-fix", async () => {
        const commitCount = Number.parseInt(runGit(`git rev-list --count main..${branchName}`), 10);
        const files = runGit(`git diff --name-only main...${branchName}`)
          .split("\n")
          .map((file) => file.trim())
          .filter((file) => file.length > 0);

        return {
          hasCommits: Number.isFinite(commitCount) && commitCount > 0,
          commitCount: Number.isFinite(commitCount) ? commitCount : 0,
          files,
        };
      });

      filesChanged = verification.files;

      if (!verification.hasCommits) {
        status = "skipped";
        message = "No commits found on friction fix branch";
      } else {
        try {
          const merge = await step.run("merge-to-main", async () => {
            runGit("git checkout main");
            runGit(`git merge --no-ff ${branchName}`);
            const sha = runGit("git rev-parse HEAD");
            return { sha };
          });

          commitSha = merge.sha;
          status = "fixed";
          message = `Friction fixed and merged to main: ${merge.sha}`;
        } catch (error) {
          status = "documented";
          message = `Merge failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }

    if (status === "skipped") {
      const escalation = await step.run("create-skip-escalation-task", async () => {
        try {
          const taskPort: TaskPort = new TodoistTaskAdapter();
          const rawContent = `Manual friction fix: ${title}`;
          const content = rawContent.length > 220 ? `${rawContent.slice(0, 217)}...` : rawContent;
          const descriptionLines = [
            `Pattern: ${patternId}`,
            `Auto-fix status: skipped (no commits found on ${branchName})`,
            `Summary: ${summary}`,
            `Suggestion: ${suggestion}`,
          ];
          if (evidence.length > 0) {
            descriptionLines.push("Evidence:");
            descriptionLines.push(...evidence.map((item: string) => `- ${item}`));
          }

          const task = await taskPort.createTask({
            content,
            description: descriptionLines.join("\n"),
            labels: ["agent", "friction", "friction-fix-skipped"],
            projectId: "Agent Work",
          });
          return { created: true as const, taskId: task.id };
        } catch (error) {
          return {
            created: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      if (escalation.created) {
        escalationTaskId = escalation.taskId;
        message = `${message}. Escalated to Todoist task ${escalation.taskId}`;
      } else {
        message = `${message}. Failed to create escalation task: ${escalation.error}`;
      }
    }

    await step.run("notify-gateway", async () => {
      try {
        if (status === "fixed" && commitSha) {
          await gateway.notify("friction-fix", {
            message: `Friction fixed: ${title}. Commit: ${commitSha}. Revert: \`git revert ${commitSha}\``,
            patternId,
            status,
            commitSha,
            filesChanged,
          });
          return { notified: true };
        }

        await gateway.notify("friction-fix", {
          message: `Friction fix ${status}: ${title}. ${message}`,
          patternId,
          status,
          filesChanged,
          escalationTaskId,
        });
        return { notified: true };
      } catch (error) {
        return {
          notified: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    await step.run("update-todoist", async () => {
      if (!todoistTaskId) {
        return { updated: false, reason: "no-task-id" };
      }

      try {
        const commentLines = [
          `Friction auto-fix result: ${status}`,
          `Pattern: ${patternId}`,
          `Title: ${title}`,
          `Message: ${message}`,
        ];
        if (commitSha) {
          commentLines.push(`Commit: ${commitSha}`);
        }
        if (escalationTaskId) {
          commentLines.push(`Escalation task: ${escalationTaskId}`);
        }

        await addTodoistComment(todoistTaskId, commentLines.join("\n"));

        const adapter = new TodoistTaskAdapter();
        await adapter.completeTask(todoistTaskId);

        return { updated: true };
      } catch (error) {
        return {
          updated: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    });

    await step.run("cleanup-branch", async () => {
      try {
        runGit("git checkout main");
        runGit(`git branch -D ${branchName}`);
        return { deleted: true };
      } catch (error) {
        return {
          deleted: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    await step.sendEvent("emit-friction-fix-completed", {
      name: "memory/friction.fix.completed",
      data: {
        patternId,
        status,
        commitSha,
        filesChanged,
        message,
      },
    });

    return {
      patternId,
      status,
      commitSha,
      filesChanged,
      message,
    };
  }
);
