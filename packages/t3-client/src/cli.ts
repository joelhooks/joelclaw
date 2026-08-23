/**
 * t3c — gateway-facing CLI for a T3 Code server.
 *
 * Commands:
 *   t3c pair '<pairing-url-or-token>' --url <http-base> [--label name]
 *   t3c status
 *   t3c threads [--json]
 *   t3c start --root <workspaceRoot> [--title t] [--model instanceId/model]
 *             [--mode runtimeMode] [--no-watch] "<prompt>"
 *   t3c watch <threadId>
 *   t3c approve <threadId> <requestId> <accept|acceptForSession|decline|cancel>
 *   t3c input <threadId> <requestId> '<answers-json>'
 *   t3c interrupt <threadId>
 *
 * Credentials: ~/.joelclaw/t3-client.json (override with T3_CLIENT_CREDENTIALS).
 */
import { connectT3, type T3Session } from "./client.ts";
import {
  defaultCredentialsPath,
  exchangePairingToken,
  loadCredentials,
  saveCredentials,
} from "./credentials.ts";
import type { GatewayEvent } from "./events.ts";

interface ParsedArgs {
  readonly positional: Array<string>;
  readonly flags: Record<string, string | boolean>;
}

/** Flags that never take a value, so they cannot eat the following argument. */
const BOOLEAN_FLAGS = new Set(["no-watch", "json"]);

function parseArgs(argv: Array<string>): ParsedArgs {
  const positional: Array<string> = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`t3c: ${message}`);
  process.exit(1);
}

function printEvent(event: GatewayEvent): void {
  switch (event.kind) {
    case "message":
      console.log(`[${event.role}] ${event.streaming ? "…" : ""}${event.text}`);
      break;
    case "activity":
      console.log(`[activity] ${event.activityKind}: ${event.summary}`);
      break;
    case "attention":
      console.log(`[ATTENTION:${event.reason}] ${event.summary}`);
      if (event.requestId) console.log(`  requestId: ${event.requestId}`);
      console.log(`  payload: ${JSON.stringify(event.payload)}`);
      break;
    case "turn-settled":
      console.log(`[settled] state=${event.state}`);
      if (event.assistantText) console.log(`[final] ${event.assistantText}`);
      break;
    case "sync":
    case "event":
      break;
  }
}

async function withSession<T>(use: (session: T3Session) => Promise<T>): Promise<T> {
  const credentials = await loadCredentials();
  const session = await connectT3(credentials);
  try {
    return await use(session);
  } finally {
    await session.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case "pair": {
      const token = positional[0] || fail("usage: t3c pair '<pairing-url-or-token>' --url <base>");
      const baseUrl = typeof flags.url === "string" ? flags.url : fail("--url <http-base> required");
      const credentials = await exchangePairingToken({
        baseUrl,
        pairingToken: token,
        clientLabel: typeof flags.label === "string" ? flags.label : undefined,
      });
      await saveCredentials(credentials);
      console.log(
        `paired with ${baseUrl}; bearer expires ${credentials.expiresAt}; saved to ${defaultCredentialsPath()}`,
      );
      return;
    }
    case "status": {
      const credentials = await loadCredentials();
      const response = await fetch(`${credentials.baseUrl}/api/auth/session`, {
        headers: { authorization: `Bearer ${credentials.bearerToken}` },
      });
      console.log(
        JSON.stringify(
          {
            baseUrl: credentials.baseUrl,
            bearerExpiresAt: credentials.expiresAt,
            session: response.ok ? await response.json() : `HTTP ${response.status}`,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "threads": {
      const snapshot = await withSession((session) => session.shellSnapshot());
      if (flags.json === true) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }
      const projectTitles = new Map(snapshot.projects.map((p) => [p.projectId, p.title]));
      for (const thread of snapshot.threads) {
        const attention = [
          thread.hasPendingApprovals ? "APPROVAL" : null,
          thread.hasPendingUserInput ? "INPUT" : null,
        ]
          .filter(Boolean)
          .join(",");
        console.log(
          `${thread.threadId}  ${(thread.turnState ?? "idle").padEnd(11)} ${
            attention ? `[${attention}] ` : ""
          }${projectTitles.get(thread.projectId) ?? "?"} :: ${thread.title}`,
        );
      }
      return;
    }
    case "start": {
      const prompt = positional[0] || fail('usage: t3c start --root <dir> "<prompt>"');
      const root = typeof flags.root === "string" ? flags.root : fail("--root <workspaceRoot> required");
      const model = typeof flags.model === "string" ? flags.model : undefined;
      const [modelInstanceId, modelName] = model?.includes("/")
        ? [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)]
        : [undefined, undefined];
      await withSession(async (session) => {
        const started = await session.startTurn({
          prompt,
          workspaceRoot: root,
          title: typeof flags.title === "string" ? flags.title : undefined,
          modelInstanceId,
          model: modelName,
          runtimeMode: typeof flags.mode === "string" ? (flags.mode as never) : undefined,
        });
        console.log(
          `started thread ${started.threadId} (project ${started.projectId}, ${started.modelInstanceId}/${started.model})`,
        );
        if (flags["no-watch"] === true) return;
        for await (const event of session.watchThread(started.threadId)) printEvent(event);
      });
      return;
    }
    case "watch": {
      const threadId = positional[0] || fail("usage: t3c watch <threadId>");
      await withSession(async (session) => {
        for await (const event of session.watchThread(threadId)) printEvent(event);
      });
      return;
    }
    case "approve": {
      const [threadId, requestId, decision] = positional;
      if (!threadId || !requestId || !decision) {
        fail("usage: t3c approve <threadId> <requestId> <accept|acceptForSession|decline|cancel>");
      }
      await withSession((session) =>
        session.respondApproval(threadId, requestId, decision as never),
      );
      console.log("approval response dispatched");
      return;
    }
    case "input": {
      const [threadId, requestId, answersJson] = positional;
      if (!threadId || !requestId || !answersJson) {
        fail("usage: t3c input <threadId> <requestId> '<answers-json>'");
      }
      await withSession((session) =>
        session.respondUserInput(threadId, requestId, JSON.parse(answersJson)),
      );
      console.log("user-input response dispatched");
      return;
    }
    case "interrupt": {
      const threadId = positional[0] || fail("usage: t3c interrupt <threadId>");
      await withSession((session) => session.interruptTurn(threadId));
      console.log("interrupt dispatched");
      return;
    }
    default:
      fail(`unknown command ${command ?? "(none)"} — see header of src/cli.ts for usage`);
  }
}

await main().catch((error) => {
  console.error("t3c failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
process.exit(0);
