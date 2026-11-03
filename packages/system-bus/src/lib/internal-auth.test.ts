import { describe, expect, test } from "bun:test";
import {
  createDenialLogger,
  decideInternalAuth,
  internalAuthMode,
  isLoopbackAddress,
  resolveBindHosts,
  serveOnHosts,
  tokensMatch,
} from "./internal-auth";

const TOKEN = "t".repeat(40);

describe("decideInternalAuth fails closed", () => {
  test("no configured token refuses every request with 503", () => {
    for (const configured of [undefined, "", "   "]) {
      expect(decideInternalAuth({ configured, presented: TOKEN, mode: "enforce" })).toEqual({
        allow: false,
        reason: "no-token-configured",
        status: 503,
      });
      expect(decideInternalAuth({ configured, presented: undefined, mode: "enforce" }).allow).toBe(false);
    }
  });

  test("missing or wrong token gets 401; the right one passes", () => {
    expect(decideInternalAuth({ configured: TOKEN, presented: undefined, mode: "enforce" })).toEqual({
      allow: false,
      reason: "missing-token",
      status: 401,
    });
    expect(decideInternalAuth({ configured: TOKEN, presented: `${TOKEN}x`, mode: "enforce" })).toMatchObject({
      allow: false,
      reason: "bad-token",
      status: 401,
    });
    expect(decideInternalAuth({ configured: TOKEN, presented: TOKEN.slice(1), mode: "enforce" }).allow).toBe(false);
    expect(decideInternalAuth({ configured: TOKEN, presented: ` ${TOKEN} `, mode: "enforce" })).toEqual({ allow: true, reason: "ok" });
  });

  test("log-only lets requests through but still names the reason", () => {
    expect(decideInternalAuth({ configured: undefined, presented: undefined, mode: "log-only" })).toEqual({
      allow: true,
      reason: "no-token-configured",
      logOnly: true,
    });
    expect(decideInternalAuth({ configured: TOKEN, presented: "nope", mode: "log-only" })).toMatchObject({
      allow: true,
      reason: "bad-token",
      logOnly: true,
    });
  });

  test("mode parsing defaults to enforce", () => {
    expect(internalAuthMode(undefined)).toBe("enforce");
    expect(internalAuthMode("")).toBe("enforce");
    expect(internalAuthMode("off")).toBe("enforce");
    expect(internalAuthMode(" Log-Only ")).toBe("log-only");
  });

  test("tokensMatch handles different lengths and empties", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch("a", TOKEN)).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
  });
});

describe("loopback and bind hosts", () => {
  test("loopback detection", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of [undefined, "", "10.0.0.5", "192.0.2.1", "::ffff:10.0.0.5", "fe80::1", "1127.0.0.1"]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });

  test("default is loopback plus the IP Inngest is told to call", () => {
    expect(resolveBindHosts({})).toEqual(["127.0.0.1"]);
    expect(resolveBindHosts({ INNGEST_SERVE_HOST: "http://192.0.2.12:3111" })).toEqual(["127.0.0.1", "192.0.2.12"]);
    expect(resolveBindHosts({ INNGEST_SERVE_HOST: "http://worker.example:3111" })).toEqual(["127.0.0.1"]);
    expect(resolveBindHosts({ INNGEST_SERVE_HOST: "http://127.0.0.1:3111" })).toEqual(["127.0.0.1"]);
    expect(resolveBindHosts({ INNGEST_SERVE_HOST: "not a url" })).toEqual(["127.0.0.1"]);
  });

  test("WORKER_BIND_HOSTS wins, and a wildcard is refused", () => {
    expect(resolveBindHosts({ WORKER_BIND_HOSTS: "127.0.0.1, 192.0.2.12,127.0.0.1", INNGEST_SERVE_HOST: "http://192.0.2.99:1" })).toEqual([
      "127.0.0.1",
      "192.0.2.12",
    ]);
    for (const w of ["0.0.0.0", "::", "*"]) {
      expect(() => resolveBindHosts({ WORKER_BIND_HOSTS: `127.0.0.1,${w}` })).toThrow(/wildcard/);
    }
    expect(() => resolveBindHosts({ INNGEST_SERVE_HOST: "http://0.0.0.0:3111" })).toThrow(/wildcard/);
  });
});

describe("serveOnHosts", () => {
  test("binds each host; a non-loopback failure retries instead of crashing", async () => {
    const calls: string[] = [];
    let tailnetUp = false;
    serveOnHosts({
      hosts: ["127.0.0.1", "192.0.2.12"],
      port: 3111,
      fetch: () => new Response("ok"),
      retryMs: 5,
      log: () => {},
      serve: ({ hostname }) => {
        calls.push(hostname);
        if (hostname !== "127.0.0.1" && !tailnetUp) throw new Error("EADDRNOTAVAIL");
        return {};
      },
    });
    expect(calls).toEqual(["127.0.0.1", "192.0.2.12"]);
    tailnetUp = true;
    await Bun.sleep(30);
    expect(calls.filter((h) => h === "192.0.2.12").length).toBe(2);
  });

  test("a loopback bind failure is fatal", () => {
    expect(() =>
      serveOnHosts({
        hosts: ["127.0.0.1"],
        port: 3111,
        fetch: () => new Response("ok"),
        log: () => {},
        serve: () => {
          throw new Error("EADDRINUSE");
        },
      }),
    ).toThrow("EADDRINUSE");
  });
});

describe("createDenialLogger", () => {
  test("one line per route, caller and reason per window", () => {
    let t = 0;
    const lines: string[] = [];
    const log = createDenialLogger({ windowMs: 1000, now: () => t, sink: (l) => lines.push(l) });
    const d = decideInternalAuth({ configured: TOKEN, presented: undefined, mode: "log-only" });
    const entry = { route: "/observability/emit", caller: "127.0.0.1", userAgent: "bun", decision: d };
    expect(log(entry)).toBe(true);
    expect(log(entry)).toBe(false);
    expect(log({ ...entry, caller: "192.0.2.12" })).toBe(true);
    t = 1500;
    expect(log(entry)).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("allowed (log-only) /observability/emit caller=127.0.0.1 reason=missing-token");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
