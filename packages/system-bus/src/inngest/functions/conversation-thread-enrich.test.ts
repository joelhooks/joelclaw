import { describe, expect, test } from "bun:test";
import { __conversationThreadEnrichTestUtils } from "./conversation-thread-enrich";

const { buildVaultSearchParams, parseThreadSummaryPayload } = __conversationThreadEnrichTestUtils;

describe("conversation-thread-enrich vault search", () => {
  test("uses keyword search and never sends empty vector_query", () => {
    const params = buildVaultSearchParams("operator thread about reboot recovery");

    expect(params.collection).toBe("vault_notes");
    expect(params.query_by).toBe("title,content,path,tags");
    expect(params.vector_query).toBeUndefined();
    expect(params.q).toBe("operator thread about reboot recovery");
  });

  test("caps oversized message text before sending it to Typesense", () => {
    const params = buildVaultSearchParams(`  ${"incident log ".repeat(600)}  `);

    expect(params.q.length).toBeLessThanOrEqual(1_200);
    expect(params.q).not.toStartWith(" ");
    expect(params.q).not.toEndWith(" ");
  });

  test("falls back to source-grounded summary when model JSON is empty", () => {
    const payload = parseThreadSummaryPayload(
      { text: "" },
      [{
        id: "m1",
        user_name: "GitHub",
        text: "Policy Validators failed on main.",
        timestamp: 123,
        urgency: "high",
      }],
      "Limited vault coverage.",
    );

    expect(payload.summary).toBe("Policy Validators failed on main.");
    expect(payload.needsJoel).toBe(true);
    expect(payload.urgency).toBe("high");
    expect(payload.vaultGapSignal).toBe("Limited vault coverage.");
  });
});
