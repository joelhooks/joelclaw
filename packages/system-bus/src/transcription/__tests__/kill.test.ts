import { describe, expect, test } from "bun:test";
import { killActorGroup } from "../actor/kill";
import type { ActorStatus } from "../types";

function makeStatus(overrides: Partial<ActorStatus> = {}): ActorStatus {
  return {
    schemaVersion: "joelclaw.transcription.actor-status.v1",
    actorId: "asr_abc#1",
    chunkId: "asr_abc",
    kind: "asr",
    requestId: "req-1",
    artifactId: "art-1",
    pid: 4242,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    state: "running",
    ...overrides,
  };
}

function esrch(): Error & { code: string } {
  const error = new Error("no such process") as Error & { code: string };
  error.code = "ESRCH";
  return error;
}

describe("killActorGroup", () => {
  test("already-dead when the initial liveness probe fails with ESRCH", async () => {
    const calls: Array<{ pid: number; signal: unknown }> = [];
    const ps = async () => {
      throw new Error("ps should never be called once the process is already dead");
    };
    const result = await killActorGroup(makeStatus(), {
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        throw esrch();
      },
      ps,
    });
    expect(result).toBe("already-dead");
    expect(calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  test("identity-mismatch never sends a process-group kill (PID reuse guard)", async () => {
    const calls: Array<{ pid: number; signal: unknown }> = [];
    const result = await killActorGroup(makeStatus(), {
      kill: (pid, signal) => {
        calls.push({ pid, signal });
      },
      ps: async () => "some-other-unrelated-process --flag",
    });
    expect(result).toBe("identity-mismatch");
    expect(calls.every((call) => call.pid > 0)).toBe(true);
    expect(calls.some((call) => call.pid < 0)).toBe(false);
  });

  test("killed via SIGTERM alone when the process dies within the grace window", async () => {
    const status = makeStatus();
    const calls: Array<{ pid: number; signal: unknown }> = [];
    let livenessCalls = 0;
    const result = await killActorGroup(status, {
      graceMs: 2000,
      sleep: async () => {},
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        if (signal === 0) {
          livenessCalls += 1;
          // First liveness probe (pre-identity-check): alive.
          // Every subsequent liveness probe (poll loop after SIGTERM): dead.
          if (livenessCalls > 1) throw esrch();
        }
      },
      ps: async () => `bun run-actor.ts --actor-tag ${status.actorId}`,
    });
    expect(result).toBe("killed");
    expect(calls.some((call) => call.pid === -4242 && call.signal === "SIGTERM")).toBe(true);
    expect(calls.some((call) => call.signal === "SIGKILL")).toBe(false);
  });

  test("escalates to SIGKILL when the process survives the grace period", async () => {
    const status = makeStatus();
    const calls: Array<{ pid: number; signal: unknown }> = [];
    const result = await killActorGroup(status, {
      graceMs: 10,
      sleep: async () => {},
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        // Liveness always reports alive; process never dies on its own.
      },
      ps: async () => `bun run-actor.ts --actor-tag ${status.actorId}`,
    });
    expect(result).toBe("killed");
    expect(calls.some((call) => call.pid === -4242 && call.signal === "SIGTERM")).toBe(true);
    expect(calls.some((call) => call.pid === -4242 && call.signal === "SIGKILL")).toBe(true);
  });

  test("swallows ESRCH on the terminal SIGTERM/SIGKILL sends", async () => {
    const status = makeStatus();
    let sigtermThrew = false;
    const result = await killActorGroup(status, {
      graceMs: 10,
      sleep: async () => {},
      kill: (_pid, signal) => {
        if (signal === "SIGTERM") {
          sigtermThrew = true;
          throw esrch();
        }
      },
      ps: async () => `bun run-actor.ts --actor-tag ${status.actorId}`,
    });
    expect(sigtermThrew).toBe(true);
    expect(result).toBe("already-dead");
  });
});
