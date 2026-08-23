/**
 * Process-boundary tests.
 *
 * The spawning tests use real child processes, because the two properties under
 * test — a deadline that survives a SIGTERM-resistant child, and an environment
 * that does not inherit the parent's — cannot be proved with a fake runner. No
 * test here contacts the flowing-memory service or the agent-secrets daemon.
 */

import { describe, expect, test } from "bun:test";
import {
  AGENT_SECRETS_CLIENT_ID,
  AGENT_SECRETS_LEASE_TTL,
  type BoundaryProcessRequest,
  type BoundaryProcessResult,
  bunProcessRunner,
  extractJsonLeaseValue,
  isValidSecretName,
  leaseAgentSecret,
  minimalChildEnv,
  redactSecret,
} from "./process-boundary";

const okResult = (overrides: Partial<BoundaryProcessResult> = {}): BoundaryProcessResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  missingExecutable: false,
  ...overrides,
});

describe("minimalChildEnv", () => {
  test("passes only the allow-listed variables and the injected value", () => {
    const env = minimalChildEnv(
      {
        PATH: "/usr/bin",
        HOME: "/Users/test",
        AWS_SECRET_ACCESS_KEY: "unrelated-token",
        GITHUB_TOKEN: "another-token",
        JOELCLAW_GATEWAY_URL: "http://private.host",
      },
      { RUNTIME_URL: "postgres://x" },
    );

    expect(env).toEqual({
      TERM: "dumb",
      PATH: "/usr/bin",
      HOME: "/Users/test",
      RUNTIME_URL: "postgres://x",
    });
  });

  test("omits an allow-listed variable that is absent or empty", () => {
    expect(minimalChildEnv({ PATH: "", HOME: undefined })).toEqual({ TERM: "dumb" });
  });
});

describe("redactSecret", () => {
  test("removes every occurrence of the leased value", () => {
    expect(redactSecret("url=abc123 again abc123", "abc123")).toBe(
      "url=[redacted] again [redacted]",
    );
  });

  test("leaves text alone when there is no secret", () => {
    expect(redactSecret("plain", undefined)).toBe("plain");
  });
});

describe("agent-secrets lease contract", () => {
  test("raw format asks for a short, self-identified lease and returns stdout", async () => {
    const seen: BoundaryProcessRequest[] = [];
    const outcome = await leaseAgentSecret({
      secretName: "flowing-runtime-url",
      format: "raw",
      timeoutMs: 500,
      executable: "/fake/secrets",
      parentEnv: { PATH: "/usr/bin", SECRET_TOKEN: "leak" },
      runProcess: async (request) => {
        seen.push(request);
        return okResult({ stdout: "postgres://reader@host/db" });
      },
    });

    expect(outcome).toEqual({ ok: true, value: "postgres://reader@host/db" });
    expect(seen[0]?.command).toEqual([
      "/fake/secrets",
      "lease",
      "flowing-runtime-url",
      "--ttl",
      AGENT_SECRETS_LEASE_TTL,
      "--client-id",
      AGENT_SECRETS_CLIENT_ID,
    ]);
    expect(AGENT_SECRETS_LEASE_TTL).toBe("5m");
    expect(AGENT_SECRETS_CLIENT_ID).toBe("joelclaw-recall-compare");
    expect(seen[0]?.env).toEqual({ TERM: "dumb", PATH: "/usr/bin" });
    expect(seen[0]?.stdin).toBe("");
  });

  test("json format adds --json and reads exactly result.value", async () => {
    const seen: BoundaryProcessRequest[] = [];
    const envelope = {
      ok: true,
      result: { value: "postgres://reader@host/db", name: "flowing-runtime-url" },
      links: [{ rel: "self", href: "/leases/1" }],
    };
    const outcome = await leaseAgentSecret({
      secretName: "flowing-runtime-url",
      format: "json",
      timeoutMs: 500,
      executable: "/fake/secrets",
      parentEnv: {},
      runProcess: async (request) => {
        seen.push(request);
        return okResult({ stdout: JSON.stringify(envelope) });
      },
    });

    expect(outcome).toEqual({ ok: true, value: "postgres://reader@host/db" });
    expect(seen[0]?.command).toEqual([
      "/fake/secrets",
      "lease",
      "flowing-runtime-url",
      "--ttl",
      AGENT_SECRETS_LEASE_TTL,
      "--client-id",
      AGENT_SECRETS_CLIENT_ID,
      "--json",
    ]);
  });

  test("never accepts the whole JSON document as the credential", () => {
    expect(extractJsonLeaseValue({ value: "top-level" })).toBeUndefined();
    expect(extractJsonLeaseValue({ secret: "top-level" })).toBeUndefined();
    expect(extractJsonLeaseValue({ data: { value: "nested" } })).toBeUndefined();
    expect(extractJsonLeaseValue({ result: { value: "correct" } })).toBe("correct");
  });

  test("a json envelope without result.value is a failure, not a fallback", async () => {
    const outcome = await leaseAgentSecret({
      secretName: "flowing-runtime-url",
      format: "json",
      timeoutMs: 500,
      executable: "/fake/secrets",
      parentEnv: {},
      runProcess: async () => okResult({ stdout: JSON.stringify({ ok: true, result: {} }) }),
    });

    expect(outcome.ok).toBe(false);
  });

  test("rejects a secret name that is not a bounded agent-secrets name", async () => {
    expect(isValidSecretName("flowing-runtime-url")).toBe(true);
    expect(isValidSecretName("../../etc/passwd")).toBe(false);
    expect(isValidSecretName("--json")).toBe(false);

    let spawned = false;
    const outcome = await leaseAgentSecret({
      secretName: "../../etc/passwd",
      format: "raw",
      timeoutMs: 500,
      runProcess: async () => {
        spawned = true;
        return okResult();
      },
    });

    expect(outcome.ok).toBe(false);
    expect(spawned).toBe(false);
  });

  test("a failing lease never quotes the backend output", async () => {
    const outcome = await leaseAgentSecret({
      secretName: "flowing-runtime-url",
      format: "raw",
      timeoutMs: 500,
      executable: "/fake/secrets",
      parentEnv: {},
      runProcess: async () =>
        okResult({
          exitCode: 4,
          stderr: "denied for postgres://reader:hunter2@host/db at /Users/joel/.secrets",
        }),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toBe("credential lease exited 4");
      expect(outcome.message).not.toContain("hunter2");
      expect(outcome.message).not.toContain("/Users/joel");
    }
  });
});

describe("bunProcessRunner", () => {
  test("passes stdin, captures stdout, and gives the child only the supplied environment", async () => {
    const result = await bunProcessRunner({
      command: [
        process.execPath,
        "-e",
        "const t = await Bun.stdin.text(); console.log(JSON.stringify({ stdin: t, env: process.env }))",
      ],
      stdin: "the private payload",
      env: { PATH: process.env.PATH ?? "/usr/bin", INJECTED: "only-this" },
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      stdin: string;
      env: Record<string, string>;
    };
    expect(parsed.stdin).toBe("the private payload");
    expect(parsed.env.INJECTED).toBe("only-this");
    // The parent process is a test runner with a large environment. None of it
    // reaches the child beyond what was handed over.
    expect(parsed.env.BUN_TEST_INHERITED_MARKER).toBeUndefined();
  }, 20_000);

  test("kills a SIGTERM-resistant child instead of waiting on it forever", async () => {
    const startedAt = Date.now();
    const result = await bunProcessRunner({
      command: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000)",
      ],
      stdin: "",
      env: { PATH: process.env.PATH ?? "/usr/bin" },
      timeoutMs: 300,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    // SIGTERM at 300ms, SIGKILL at 550ms. Anything past a couple of seconds
    // means the deadline is advisory, which is the defect this guards.
    expect(elapsed).toBeLessThan(3_000);
  }, 20_000);

  test("reports a missing executable rather than throwing", async () => {
    const result = await bunProcessRunner({
      command: ["/nonexistent/flowing-recall-read-xyz"],
      stdin: "",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
    });

    expect(result.missingExecutable).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 20_000);
});
