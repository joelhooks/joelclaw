import { describe, expect, mock, test } from "bun:test";
import { NonRetriableError } from "inngest";
import {
  isRatKingName,
  type NotifyAgentDependencies,
  NotifyAgentError,
  NotifyAgentUncertainError,
  notifyAgent,
} from "./notify-agent";

const input = {
  to: "switchboard/ea",
  source: "fixture",
  summary: "Test receipt",
  message: "Body only on stdin",
  quiet: true,
};

function setup(exit = 0) {
  const kill = mock(() => undefined);
  const spawn = mock(
    (_argv: string[], _options: Parameters<NotifyAgentDependencies["spawn"]>[1]) => ({
      exited: Promise.resolve(exit),
      kill,
    }),
  );
  const emit = mock(async (_event: Parameters<NotifyAgentDependencies["emit"]>[0]) => undefined);
  const setTimer = mock(
    (_callback: () => void, _ms: number) => 1 as unknown as ReturnType<typeof setTimeout>,
  );
  const clearTimer = mock(() => undefined);
  const deps: NotifyAgentDependencies = {
    spawn,
    emit,
    env: { JOELCLAW_RATKING_NAME: "worker/notifications" },
    setTimer,
    clearTimer,
  };
  return { deps, spawn, emit, setTimer, clearTimer, kill };
}

describe("notifyAgent", () => {
  test("uses exact argv, stdin, a 15s deadline and body-free quiet telemetry", async () => {
    const { deps, spawn, emit, setTimer, clearTimer } = setup();
    await notifyAgent(input, deps);
    expect(spawn.mock.calls[0]?.[0]).toEqual([
      "ratking",
      "send",
      "--as",
      "worker/notifications",
      "--to",
      "switchboard/ea",
      "--quiet",
      "--summary",
      "Test receipt",
      "--body",
      "-",
      "--json",
    ]);
    expect(spawn.mock.calls[0]?.[1]).toEqual({
      stdin: new TextEncoder().encode(input.message),
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(setTimer.mock.calls[0]?.[1]).toBe(15_000);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      action: "agent.notify.sent",
      metadata: { source: "fixture", to: "switchboard/ea", quiet: true },
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain(input.message);
  });

  test("maps cc to repeated --cc flags and rejects invalid cc names", async () => {
    const { deps, spawn } = setup();
    await notifyAgent({ ...input, quiet: false, cc: ["switchboard/ea", "muster/desk"] }, deps);
    expect(spawn.mock.calls[0]?.[0]).toEqual([
      "ratking",
      "send",
      "--as",
      "worker/notifications",
      "--to",
      "switchboard/ea",
      "--cc",
      "switchboard/ea",
      "--cc",
      "muster/desk",
      "--summary",
      "Test receipt",
      "--body",
      "-",
      "--json",
    ]);
    await expect(notifyAgent({ ...input, cc: ["Bad Name"] }, deps)).rejects.toMatchObject({
      code: "invalid_recipient",
    });
  });

  test("honors RATKING_BIN and redacts both summary and body before truncation", async () => {
    const { deps, spawn } = setup();
    deps.env.RATKING_BIN = "custom-ratking";
    await notifyAgent(
      {
        ...input,
        summary: `https://example.invalid ${"x".repeat(400)}\nsecond line`,
        message: "See /private/work/receipt.txt at https://example.invalid",
      },
      deps,
    );
    const [argv, options] = spawn.mock.calls[0]!;
    expect(argv[0]).toBe("custom-ratking");
    expect(argv[8]).toHaveLength(280);
    expect(argv[8]).toStartWith("[address] ");
    expect(argv[8]).not.toContain("\n");
    expect(new TextDecoder().decode(options.stdin)).toBe("See receipt.txt at [address]");
  });

  for (const [exit, code] of [
    [2, "refused"],
    [4, "lease_held"],
    [1, "exit_failed"],
    [99, "exit_failed"],
  ] as const) {
    test(`maps exit ${exit} to ${code}`, async () => {
      const { deps, emit } = setup(exit);
      await expect(notifyAgent(input, deps)).rejects.toMatchObject({ code, exitCode: exit });
      expect(emit.mock.calls[0]?.[0]).toMatchObject({
        action: "agent.notify.failed",
        metadata: { code, exitCode: exit },
      });
    });
  }

  test("exit 3 is typed and non-retriable", async () => {
    const { deps } = setup(3);
    try {
      await notifyAgent(input, deps);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NotifyAgentUncertainError);
      expect(error).toBeInstanceOf(NonRetriableError);
      expect(error).toMatchObject({ code: "uncertain", exitCode: 3 });
    }
  });

  test("timeout kills the child and is non-retriable even if it never exits", async () => {
    const { deps, kill, clearTimer, emit } = setup();
    let expire: (() => void) | undefined;
    deps.spawn = () => ({ exited: new Promise(() => {}), kill });
    deps.setTimer = (callback, ms) => {
      expect(ms).toBe(15_000);
      expire = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    };
    const pending = notifyAgent(input, deps);
    expire!();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    await expect(pending).rejects.toBeInstanceOf(NonRetriableError);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0].action).toBe("agent.notify.failed");
  });

  test("rejects a missing or invalid sender without spawning", async () => {
    for (const sender of [undefined, " ", "--unsafe"]) {
      const { deps, spawn } = setup();
      deps.env.JOELCLAW_RATKING_NAME = sender;
      await expect(notifyAgent(input, deps)).rejects.toMatchObject({ code: "missing_name" });
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  test("rejects invalid recipients and applies the specified name grammar", async () => {
    for (const to of ["Upper", "worker_name", "a/b/c", "-flag", "a b", ""]) {
      const { deps, spawn } = setup();
      expect(isRatKingName(to)).toBe(false);
      await expect(notifyAgent({ ...input, to }, deps)).rejects.toBeInstanceOf(NotifyAgentError);
      expect(spawn).not.toHaveBeenCalled();
    }
    for (const to of ["worker", "worker-1/ea", "a/0"]) expect(isRatKingName(to)).toBe(true);
  });

  test("spawn and exit-promise errors never expose body, CLI output or causes", async () => {
    const secret = "secret-fixture-not-a-credential";
    for (const asynchronous of [false, true]) {
      const { deps, emit } = setup();
      deps.spawn = () => {
        if (!asynchronous) throw new Error(secret);
        return { exited: Promise.reject(new Error(secret)), kill: () => {} };
      };
      try {
        await notifyAgent({ ...input, message: secret }, deps);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(NotifyAgentError);
        expect(String(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect((error as Error).cause).toBeUndefined();
      }
      expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
    }
  });

  test("telemetry failure after success cannot cause an automatic resend", async () => {
    const { deps, spawn } = setup();
    deps.emit = async () => {
      throw new Error("telemetry unavailable");
    };
    await notifyAgent(input, deps);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
