import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunBlob } from "@joelclaw/memory";
import { Hono } from "hono";
import { registerRunCaptureRoute } from "./run-capture";
import { authenticateCaptureBearer } from "./run-capture-auth";

// The run-capture route once accepted a hard-coded development bearer as Joel's identity. That string is public in
// this repo's history, so it must never authenticate again. Only the identity registry decides.
const RETIRED_DEV_BEARER = "dev-joel-panda";
const REGISTERED = "registered-fixture-token";
const identity = { user_id: "user", machine_id: "machine", did: null };

const registry = {
  lookup: async (token: string) => (token === REGISTERED ? identity : null),
};

let fixtureRoot: string | undefined;
afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
  delete process.env.MEMORY_RUN_STORE;
});

function app() {
  fixtureRoot = mkdtempSync(join(tmpdir(), "run-capture-bearer-"));
  process.env.MEMORY_RUN_STORE = join(fixtureRoot, "runs");
  const hono = new Hono();
  registerRunCaptureRoute(hono, {
    authenticate: (c) => authenticateCaptureBearer(registry, c.req.header("authorization")),
    writeRunBlob,
    sourceCursorClaimDir: join(fixtureRoot, "cursor-claims"),
    captureCell: { mode: "off", shadow: async () => {} },
    sendCaptured: async () => {},
    now: () => Date.UTC(2026, 0, 2),
  });
  return hono;
}

function post(hono: Hono, authorization?: string) {
  return hono.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: "not-json",
  });
}

describe("run-capture bearer authentication", () => {
  test("the retired development bearer is refused", async () => {
    expect(await authenticateCaptureBearer(registry, `Bearer ${RETIRED_DEV_BEARER}`)).toBeNull();
    expect((await post(app(), `Bearer ${RETIRED_DEV_BEARER}`)).status).toBe(401);
  });

  test("missing, empty and non-bearer headers are refused", async () => {
    expect((await post(app())).status).toBe(401);
    expect((await post(app(), "Bearer   ")).status).toBe(401);
    expect((await post(app(), `Basic ${REGISTERED}`)).status).toBe(401);
  });

  test("the worker wires the route to the registry-only helper, with no literal bearer", () => {
    const serve = readFileSync(join(import.meta.dir, "..", "serve.ts"), "utf8");
    expect(serve).toContain("authenticateCaptureBearer(");
    expect(serve).not.toContain(RETIRED_DEV_BEARER);
    expect(serve).not.toMatch(/token\s*===\s*["'`]/u);
  });

  test("a registry identity still passes authentication", async () => {
    expect(await authenticateCaptureBearer(registry, `Bearer ${REGISTERED}`)).toEqual(identity);
    expect((await post(app(), `Bearer ${REGISTERED}`)).status).not.toBe(401);
  });
});
