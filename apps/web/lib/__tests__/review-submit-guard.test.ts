import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkReviewSubmit, clientIdentifier } from "../review-submit-guard";

const allow = async () => ({ success: true });
const owner = async () => true;

describe("review submit guard", () => {
  test("lets the owner through", async () => {
    assert.deepEqual(await checkReviewSubmit({ isOwner: owner, limit: allow }), { ok: true });
  });

  test("refuses a signed-out or non-owner caller with 401", async () => {
    const decision = await checkReviewSubmit({ isOwner: async () => false, limit: allow });
    assert.equal(decision.ok, false);
    assert.equal(!decision.ok && decision.status, 401);
  });

  test("refuses with 401 when the owner check throws", async () => {
    const decision = await checkReviewSubmit({
      isOwner: async () => {
        throw new Error("auth down");
      },
      limit: allow,
    });
    assert.equal(!decision.ok && decision.status, 401);
  });

  test("treats a non-boolean owner answer as not the owner", async () => {
    const decision = await checkReviewSubmit({ isOwner: async () => "yes" as unknown as boolean, limit: allow });
    assert.equal(!decision.ok && decision.status, 401);
  });

  test("rate limits before checking the owner", async () => {
    let asked = false;
    const decision = await checkReviewSubmit({
      isOwner: async () => {
        asked = true;
        return true;
      },
      limit: async () => ({ success: false }),
    });
    assert.equal(!decision.ok && decision.status, 429);
    assert.equal(asked, false);
  });

  test("a limiter outage does not block the owner", async () => {
    const decision = await checkReviewSubmit({
      isOwner: owner,
      limit: async () => {
        throw new Error("redis down");
      },
    });
    assert.deepEqual(decision, { ok: true });
  });

  test("no limiter configured still requires the owner", async () => {
    assert.deepEqual(await checkReviewSubmit({ isOwner: owner, limit: async () => null }), { ok: true });
    const decision = await checkReviewSubmit({ isOwner: async () => false, limit: async () => null });
    assert.equal(!decision.ok && decision.status, 401);
  });

  test("identifies the caller by the first forwarded address", () => {
    const request = new Request("https://example.test/api/review/submit", {
      headers: { "x-forwarded-for": "192.0.2.10, 198.51.100.7" },
    });
    assert.equal(clientIdentifier(request), "192.0.2.10");
    assert.equal(clientIdentifier(new Request("https://example.test/")), "anonymous");
  });
});
