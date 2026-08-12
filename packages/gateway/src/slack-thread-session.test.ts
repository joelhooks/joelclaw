import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackThreadSessionRegistry } from "./slack-thread-session";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(now = new Date("2026-08-12T16:00:00.000Z")) {
  const root = join(tmpdir(), `slack-thread-session-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(join(root, ".brain/projects/demo"), { recursive: true });
  await writeFile(join(root, ".brain/projects/demo/brief.svx"), "# Demo\n");
  let clock = now;
  const registry = new SlackThreadSessionRegistry(
    join(root, "sessions.json"),
    () => clock,
  );
  return {
    root,
    registry,
    setNow(value: Date) {
      clock = value;
    },
  };
}

describe("SlackThreadSessionRegistry", () => {
  test("activates a verified binding and survives registry reconstruction", async () => {
    const tested = await harness();
    const activated = await tested.registry.activate({
      channelId: "C1",
      channelName: "lc-demo",
      threadTs: "1.000",
      binding: {
        cwd: tested.root,
        brainEntry: ".brain/projects/demo/brief.svx",
      },
    });
    expect(activated.status).toBe("bound");

    await tested.registry.attachRuntime({
      channelId: "C1",
      threadTs: "1.000",
      sessionId: "session-1",
      paneId: "w1:p1",
      workspaceId: "w1",
    });
    const restored = await new SlackThreadSessionRegistry(
      join(tested.root, "sessions.json"),
    ).get("C1", "1.000");
    expect(restored).toMatchObject({
      status: "running",
      sessionId: "session-1",
      paneId: "w1:p1",
      binding: { cwd: tested.root },
    });
  });

  test("fails closed to a neutral session for an invalid project", async () => {
    const tested = await harness();
    const activated = await tested.registry.activate({
      channelId: "C1",
      channelName: "lc-demo",
      threadTs: "1.000",
      binding: { cwd: "/not/a/project" },
    });
    expect(activated.status).toBe("neutral");
    expect(activated.binding).toBeUndefined();
  });

  test("reopens during quiet time and retires only after expiry", async () => {
    const tested = await harness();
    await tested.registry.activate({
      channelId: "C1",
      channelName: "lc-demo",
      threadTs: "1.000",
    });
    await tested.registry.resolve("C1", "1.000", 60_000);
    tested.setNow(new Date("2026-08-12T16:00:30.000Z"));
    const reopened = await tested.registry.noteHumanReply("C1", "1.000");
    expect(reopened?.status).toBe("neutral");
    expect(reopened?.retireAfter).toBeUndefined();

    await tested.registry.resolve("C1", "1.000", 60_000);
    tested.setNow(new Date("2026-08-12T16:02:00.000Z"));
    expect((await tested.registry.retireDue()).map((session) => session.status)).toEqual(["retired"]);
  });
});
