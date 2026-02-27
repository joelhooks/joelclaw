import { describe, expect, test } from "vitest";
import {
  classifyPriority,
  Priority,
  type StoredMessage,
} from "../src";

describe("classifyPriority", () => {
  test("returns P0 for slash command messages", () => {
    expect(classifyPriority({
      source: "discord:123",
      prompt: "/command ping",
      metadata: { event: "dispatch" },
    })).toBe(Priority.P0);
  });

  test("returns P1 for telegram human messages", () => {
    expect(classifyPriority({
      source: "telegram:123",
      prompt: "Please summarize this PR",
      metadata: { event: "telegram.human" },
    })).toBe(Priority.P1);
  });

  test("returns P2 for heartbeat messages", () => {
    expect(classifyPriority({
      source: "heartbeat",
      prompt: "heartbeat: ok",
      event: "cron.heartbeat",
    })).toBe(Priority.P2);
  });

  test("returns P3 for routine messages", () => {
    expect(classifyPriority({
      source: "console",
      prompt: "what's new?",
    })).toBe(Priority.P3);
  });
});

describe("Priority enum", () => {
  test("maps to numeric ladder", () => {
    expect(Priority.P0).toBe(0);
    expect(Priority.P1).toBe(1);
    expect(Priority.P2).toBe(2);
    expect(Priority.P3).toBe(3);
  });
});

describe("StoredMessage type shape", () => {
  test("has required properties", () => {
    const sample: StoredMessage = {
      id: "1749990000000-0",
      source: "telegram:123",
      prompt: "hello",
      metadata: { event: "telegram.human" },
      timestamp: 1_749_990_000_000,
      priority: Priority.P1,
      acked: true,
    };

    expect(sample).toMatchObject({
      id: expect.any(String),
      source: expect.any(String),
      prompt: expect.any(String),
      timestamp: expect.any(Number),
      priority: Priority.P1,
      acked: true,
    });
  });
});
