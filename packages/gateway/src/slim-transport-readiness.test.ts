import { describe, expect, test } from "bun:test";
import { startChannelRuntimeWithLiveness } from "./slim-transport-readiness";

describe("slim transport liveness order", () => {
  test("publishes PID and heartbeat after channel ownership and before caller drain", async () => {
    const calls: string[] = [];

    await startChannelRuntimeWithLiveness({
      startChannelRuntime: async () => {
        calls.push("channels:start");
      },
      publishPid: async () => {
        calls.push("liveness:pid");
      },
      publishHeartbeat: async () => {
        calls.push("liveness:heartbeat");
      },
    });
    calls.push("queue:drain");

    expect(calls).toEqual([
      "channels:start",
      "liveness:pid",
      "liveness:heartbeat",
      "queue:drain",
    ]);
  });

  test("does not publish liveness when channel ownership fails", async () => {
    const calls: string[] = [];

    await expect(startChannelRuntimeWithLiveness({
      startChannelRuntime: async () => {
        calls.push("channels:start");
        throw new Error("channel ownership failed");
      },
      publishPid: async () => {
        calls.push("liveness:pid");
      },
      publishHeartbeat: async () => {
        calls.push("liveness:heartbeat");
      },
    })).rejects.toThrow("channel ownership failed");

    expect(calls).toEqual(["channels:start"]);
  });
});
