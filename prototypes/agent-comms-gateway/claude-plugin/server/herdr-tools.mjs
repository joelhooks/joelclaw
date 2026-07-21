import { runJson } from "./process.mjs";

function target(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("target must be a non-empty string");
  return value.trim();
}

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
  };
}
