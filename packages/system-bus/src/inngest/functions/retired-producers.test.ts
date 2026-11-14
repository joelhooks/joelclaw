import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("retired pitch callbacks and reminder are absent from all function registries", () => {
  for (const registry of ["index.ts", "index.host.ts", "index.cluster.ts"]) {
    expect(source(registry)).not.toMatch(
      /adrDailyPitch|adrPitchApproved|adrPitchRejected|signalReminder|vipEmailBrief/,
    );
  }
  for (const file of [
    "adr-daily-pitch.ts",
    "signal-reminder.ts",
    "signal-reminder.test.ts",
    "vip-morning-brief.ts",
    "vip-morning-brief.test.ts",
  ]) {
    expect(existsSync(new URL(file, import.meta.url))).toBe(false);
  }
});

test("only the retired-producer sweep leaves no live gateway/send.message sender here", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter(
    (file) =>
      file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "gateway-send-message.ts",
  );
  expect(
    files
      .filter((file) =>
        /name:\s*(?:"gateway\/send\.message"|GATEWAY_SEND_MESSAGE_EVENT\b)/u.test(source(file)),
      )
      .sort(),
  ).toEqual([]);
  expect(source("content-review.ts")).not.toContain("sendContentReviewToGateway");
  expect(source("queue-observer.ts")).not.toContain("send-queue-observer-report");
});
