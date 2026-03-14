import { describe, expect, test } from "bun:test";

import { __vipEmailReceivedTestUtils } from "./vip-email-received";

describe("vip-email-received prompt budgeting", () => {
  test("clipPromptText truncates oversized excerpts with an ellipsis", () => {
    const clipped = __vipEmailReceivedTestUtils.clipPromptText("x".repeat(20), 8);

    expect(clipped).toBe("xxxxxxx…");
  });

  test("buildAnalysisPrompt keeps head+tail thread context and inserts omission markers", () => {
    const prompt = __vipEmailReceivedTestUtils.buildAnalysisPrompt({
      senderDisplay: "Alex Example <alex@example.com>",
      subject: "Important partnership follow-up",
      conversationId: "cnv_123",
      preview: "Latest update from Alex",
      frontContext: {
        summary: {
          subject: "Important partnership follow-up",
          status: "open",
          tags: ["vip"],
          messageCount: 20,
        },
        messages: Array.from({ length: 20 }, (_, index) => ({
          id: `msg_${index + 1}`,
          senderName: "Alex Example",
          senderEmail: "alex@example.com",
          senderDisplay: "Alex Example <alex@example.com>",
          createdAt: 1_700_000_000_000 + index,
          createdAtIso: `2026-03-13T00:00:${String(index).padStart(2, "0")}Z`,
          text: `Message ${index + 1} ${"body ".repeat(120)}`,
          isInbound: true,
        })),
        latestMessage: {
          id: "msg_20",
          senderName: "Alex Example",
          senderEmail: "alex@example.com",
          senderDisplay: "Alex Example <alex@example.com>",
          createdAt: 1_700_000_000_020,
          createdAtIso: "2026-03-13T00:00:20Z",
          text: `Message 20 ${"body ".repeat(120)}`,
          isInbound: true,
        },
        joelReplied: false,
      },
      followedLinks: Array.from({ length: 5 }, (_, index) => ({
        url: `https://example.com/${index + 1}`,
        content: `Linked content ${index + 1} ${"context ".repeat(120)}`,
      })),
      granolaMeetings: [
        {
          id: "meeting_1",
          title: "Alex partnership sync",
          date: "2026-03-10",
          participants: ["Alex Example", "Joel Hooks"],
        },
      ],
      memoryContext: Array.from({ length: 10 }, (_, index) => `Memory hit ${index + 1} ${"history ".repeat(80)}`),
      githubRepos: Array.from({ length: 8 }, (_, index) => ({
        name: `repo-${index + 1}`,
        description: `Repo description ${index + 1} ${"details ".repeat(80)}`,
        url: `https://github.com/example/repo-${index + 1}`,
      })),
      accessGaps: Array.from({ length: 10 }, (_, index) => ({
        item: `Gap ${index + 1}`,
        why_missing: `Why missing ${index + 1} ${"details ".repeat(40)}`,
        how_to_get_it: `How to get ${index + 1} ${"steps ".repeat(20)}`,
      })),
    });

    expect(prompt).toContain("Message 1");
    expect(prompt).toContain("Message 3");
    expect(prompt).toContain("Message 20");
    expect(prompt).toContain("middle thread message(s) omitted for prompt budget");
    expect(prompt).not.toContain("Message 4 body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body body");
    expect(prompt).toContain("additional link(s) omitted for prompt budget");
    expect(prompt).toContain("additional memory hit(s) omitted for prompt budget");
    expect(prompt).toContain("additional repo(s) omitted for prompt budget");
    expect(prompt).toContain("additional access gap(s) omitted for prompt budget");
  });
});
