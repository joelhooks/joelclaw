import { mkdir, writeFile } from "node:fs/promises";
import { runJson } from "./process.mjs";

function target(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("target must be a non-empty string");
  return value.trim();
}

const TASK_DIR = "/tmp/joelclaw/gateway-tasks";

export function createHerdrTools({ run = runJson } = {}) {
  return {
    snapshot: async () => {
      const [agents, panes] = await Promise.all([
        run("herdr", ["agent", "list"]),
        run("herdr", ["pane", "list"]),
      ]);
      return { agents, panes, capturedAt: new Date().toISOString() };
    },
    read: ({ target: rawTarget, lines = 80, source = "recent-unwrapped" }) =>
      run("herdr", ["agent", "read", target(rawTarget), "--source", source, "--lines", String(lines)]),
    prompt: ({ target: rawTarget, text, wait = false, timeoutMs = 120_000 }) => {
      if (typeof text !== "string" || text.trim() === "") throw new Error("text must be a non-empty string");
      const args = ["agent", "prompt", target(rawTarget), text];
      if (wait) args.push("--wait", "--timeout", String(timeoutMs));
      return run("herdr", args, { timeout: wait ? timeoutMs + 5_000 : 30_000 });
    },
    wait: ({ target: rawTarget, states = ["idle", "done", "blocked"], timeoutMs = 120_000 }) => {
      const args = ["agent", "wait", target(rawTarget), "--timeout", String(timeoutMs)];
      for (const state of states) args.push("--until", state);
      return run("herdr", args, { timeout: timeoutMs + 5_000 });
    },
    dispatchWorker: async ({ taskId, label, task }) => {
      if (typeof taskId !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(taskId)) {
        throw new Error("taskId must be a kebab-case slug");
      }
      if (typeof task !== "string" || task.trim().length === 0) throw new Error("task must be non-empty");
      const paneLabel = typeof label === "string" && label.trim() ? label.trim() : `🛠️ ${taskId}`;
      // Land the worker in the gateway's own workspace, next to the loop.
      const panes = await run("herdr", ["pane", "list"]);
      const gatewayPane = (panes?.result?.panes ?? []).find((pane) => pane.label === "📨 gateway loop");
      const workspace = gatewayPane?.workspace_id;
      if (!workspace) throw new Error("gateway loop pane not found; cannot place worker");
      await mkdir(TASK_DIR, { recursive: true });
      const taskFile = `${TASK_DIR}/${taskId}.md`;
      await writeFile(taskFile, [
        `# Gateway worker task: ${taskId}`,
        "",
        task.trim(),
        "",
        "## Returning your result",
        "When finished, send your result back through the gateway (this is the ONLY return path):",
        "",
        "```bash",
        `joelclaw notify send "worker ${taskId} done: <one-paragraph result>" --data '{"taskId":"${taskId}"}'`,
        "```",
        "",
        "Then print DONE and stop. Do not commit anything. Do not message Joel any other way.",
      ].join("\n"), "utf8");
      const created = await run("herdr", ["tab", "create", "--workspace", workspace, "--label", paneLabel]);
      const paneId = created?.result?.root_pane?.pane_id;
      if (!paneId) throw new Error(`tab create returned no pane: ${JSON.stringify(created)}`);
      await run("herdr", ["pane", "rename", paneId, paneLabel]);
      await run("herdr", ["pane", "run", paneId, `pi @${taskFile} "Execute the task in the attached brief. Work autonomously. Print DONE when finished."`]);
      return { taskId, paneId, taskFile, resultReturnsVia: "stream message.requested with data.taskId" };
    },
  };
}
