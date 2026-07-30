import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCaptureIdentityResolver,
  lookupCaptureIdentity,
} from "./run-capture-auth";

const baseOptions = {
  token: "fixture-token",
  typesenseUrl: "http://typesense.test",
  typesenseApiKey: "fixture-key",
  machinesCollection: "machines_dev",
};

const testDirectories: string[] = [];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function registryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "capture-auth-"));
  testDirectories.push(directory);
  return join(directory, "capture-identities.db");
}

describe("capture identity lookup", () => {
  test("resolves a persisted identity while Typesense is unavailable", async () => {
    const databasePath = registryPath();
    const seeded = createCaptureIdentityResolver({
      ...baseOptions,
      databasePath,
      fetchImpl: async () =>
        Response.json({
          found: 1,
          hits: [
            {
              document: {
                id: "blaine",
                user_id: "joel",
                did: "did:fixture",
                app_password_sha256:
                  "d07f963c2bb7a3cc74a910e51ca0075b194da412a93737881f105a55156a988f",
              },
            },
          ],
        }),
    });
    await seeded.synchronize();
    seeded.close();

    let typesenseCalls = 0;
    const offline = createCaptureIdentityResolver({
      ...baseOptions,
      databasePath,
      fetchImpl: async () => {
        typesenseCalls += 1;
        throw new Error("Typesense is rebuilding");
      },
    });

    expect(await offline.lookup("fixture-token")).toEqual({
      user_id: "joel",
      machine_id: "blaine",
      did: "did:fixture",
    });
    expect(typesenseCalls).toBe(0);
    offline.close();
  });

  test("persists an identity found by the bounded Typesense fallback", async () => {
    const databasePath = registryPath();
    const migrating = createCaptureIdentityResolver({
      ...baseOptions,
      databasePath,
      fetchImpl: async () =>
        Response.json({
          hits: [
            {
              document: {
                id: "flagg",
                user_id: "joel",
                did: "did:fixture",
              },
            },
          ],
        }),
    });

    expect(await migrating.lookup("fixture-token")).toEqual({
      user_id: "joel",
      machine_id: "flagg",
      did: "did:fixture",
    });
    expect(migrating.count()).toBe(1);
    migrating.close();

    const offline = createCaptureIdentityResolver({
      ...baseOptions,
      databasePath,
      fetchImpl: async () => {
        throw new Error("Typesense is rebuilding");
      },
    });
    expect(await offline.lookup("fixture-token")).toEqual({
      user_id: "joel",
      machine_id: "flagg",
      did: "did:fixture",
    });
    offline.close();
  });

  test("applies revocation during background synchronization", async () => {
    let revoked = false;
    const resolver = createCaptureIdentityResolver({
      ...baseOptions,
      databasePath: registryPath(),
      fetchImpl: async () =>
        Response.json({
          hits: [
            {
              document: {
                id: "blaine",
                user_id: "joel",
                did: "did:fixture",
                app_password_sha256:
                  "d07f963c2bb7a3cc74a910e51ca0075b194da412a93737881f105a55156a988f",
                ...(revoked ? { revoked_at: 1_785_000_000_000 } : {}),
              },
            },
          ],
        }),
    });

    await resolver.synchronize();
    expect(await resolver.lookup("fixture-token")).toMatchObject({ machine_id: "blaine" });

    revoked = true;
    await resolver.synchronize();
    expect(await resolver.lookup("fixture-token")).toBeNull();
    resolver.close();
  });

  test("keeps the working registry when synchronization returns no Machines", async () => {
    let empty = false;
    const resolver = createCaptureIdentityResolver({
      ...baseOptions,
      databasePath: registryPath(),
      fetchImpl: async () =>
        Response.json({
          hits: empty
            ? []
            : [
                {
                  document: {
                    id: "blaine",
                    user_id: "joel",
                    did: "did:fixture",
                    app_password_sha256:
                      "d07f963c2bb7a3cc74a910e51ca0075b194da412a93737881f105a55156a988f",
                  },
                },
              ],
        }),
    });

    await resolver.synchronize();
    empty = true;
    await expect(resolver.synchronize()).rejects.toThrow("zero Machine records");
    expect(await resolver.lookup("fixture-token")).toMatchObject({ machine_id: "blaine" });
    resolver.close();
  });

  test("returns a valid active machine", async () => {
    const identity = await lookupCaptureIdentity({
      ...baseOptions,
      fetchImpl: async () =>
        Response.json({
          hits: [
            {
              document: {
                id: "blaine",
                user_id: "joel",
                did: "did:fixture",
              },
            },
          ],
        }),
    });

    expect(identity).toEqual({
      user_id: "joel",
      machine_id: "blaine",
      did: "did:fixture",
    });
  });

  test("bounds a stuck Typesense lookup", async () => {
    const startedAt = performance.now();
    const identity = await lookupCaptureIdentity({
      ...baseOptions,
      timeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });

    expect(identity).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("rejects revoked and malformed machine records", async () => {
    const revoked = await lookupCaptureIdentity({
      ...baseOptions,
      fetchImpl: async () =>
        Response.json({
          hits: [{ document: { id: "flagg", user_id: "joel", revoked_at: Date.now() } }],
        }),
    });
    const malformed = await lookupCaptureIdentity({
      ...baseOptions,
      fetchImpl: async () =>
        Response.json({ hits: [{ document: { id: 42, user_id: "joel" } }] }),
    });

    expect(revoked).toBeNull();
    expect(malformed).toBeNull();
  });
});
