import { describe, expect, test } from "bun:test";
import { lookupCaptureIdentity } from "./run-capture-auth";

const baseOptions = {
  token: "fixture-token",
  typesenseUrl: "http://typesense.test",
  typesenseApiKey: "fixture-key",
  machinesCollection: "machines_dev",
};

describe("capture identity lookup", () => {
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
