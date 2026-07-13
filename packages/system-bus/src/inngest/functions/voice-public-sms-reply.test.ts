import { describe, expect, test } from "bun:test";
import { isCarrierKeyword, parseInboundSms, truncateReply } from "./voice-public-sms-reply";

const PUBLIC_DID = "+13609258342";

function inbound(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-1",
    direction: "inbound",
    type: "SMS",
    text: "how does the memory pipeline work?",
    from: { phone_number: "+15555550100" },
    to: [{ phone_number: PUBLIC_DID }],
    ...overrides,
  };
}

describe("parseInboundSms", () => {
  test("accepts an inbound text to the public DID", () => {
    const parsed = parseInboundSms(inbound());
    expect(parsed).toEqual({
      messageId: "msg-1",
      from: "+15555550100",
      text: "how does the memory pipeline work?",
    });
  });

  test("rejects outbound direction", () => {
    expect(parseInboundSms(inbound({ direction: "outbound" }))).toBeNull();
  });

  test("rejects messages not addressed to the public DID", () => {
    expect(parseInboundSms(inbound({ to: [{ phone_number: "+13603894321" }] }))).toBeNull();
  });

  test("rejects self-sent messages (loop guard)", () => {
    expect(parseInboundSms(inbound({ from: { phone_number: PUBLIC_DID } }))).toBeNull();
  });

  test("rejects empty and keyword-only texts", () => {
    expect(parseInboundSms(inbound({ text: "  " }))).toBeNull();
    expect(parseInboundSms(inbound({ text: "STOP" }))).toBeNull();
    expect(parseInboundSms(inbound({ text: " help " }))).toBeNull();
  });

  test("truncates oversized inbound text", () => {
    const parsed = parseInboundSms(inbound({ text: "x".repeat(5000) }));
    expect(parsed?.text.length).toBe(1000);
  });
});

describe("isCarrierKeyword", () => {
  test("matches carrier keywords case-insensitively", () => {
    for (const word of ["STOP", "stop", "Unsubscribe", "HELP", "start", "YES"]) {
      expect(isCarrierKeyword(word)).toBe(true);
    }
  });

  test("does not match ordinary questions", () => {
    expect(isCarrierKeyword("stop telling me about kubernetes")).toBe(false);
  });
});

describe("truncateReply", () => {
  test("passes short replies through", () => {
    expect(truncateReply("  hi there  ")).toBe("hi there");
  });

  test("cuts long replies under the segment ceiling at a word break", () => {
    const long = `${"word ".repeat(200)}end`;
    const cut = truncateReply(long);
    expect(cut.length).toBeLessThanOrEqual(450);
    expect(cut.endsWith("…")).toBe(true);
  });
});
