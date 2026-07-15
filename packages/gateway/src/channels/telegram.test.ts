import { describe, expect, test } from "bun:test";
import { __telegramTestUtils } from "./telegram";

const { isDefinitiveTelegramRejection } = __telegramTestUtils;

describe("Telegram retry safety", () => {
  test("retries only after a definitive Bot API rejection", () => {
    expect(isDefinitiveTelegramRejection({ error_code: 400 })).toBe(true);
    expect(isDefinitiveTelegramRejection({ error_code: "400" })).toBe(true);
  });

  test("does not retry ambiguous transport or rate-limit failures", () => {
    expect(isDefinitiveTelegramRejection({ name: "FetchError", code: "ECONNRESET" })).toBe(false);
    expect(isDefinitiveTelegramRejection({ error_code: 429 })).toBe(false);
    expect(isDefinitiveTelegramRejection(new Error("socket closed"))).toBe(false);
  });
});
