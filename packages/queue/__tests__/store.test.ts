import { describe, expect, test } from "vitest";
import {
  Priority,
  type StoredMessage,
} from "../src";
import { __queueTestUtils } from "../src/store";

const { toPriority, priorityName } = __queueTestUtils;

describe("Priority enum", () => {
  test("maps to numeric ladder", () => {
    expect(Priority.P0).toBe(0);
    expect(Priority.P1).toBe(1);
    expect(Priority.P2).toBe(2);
    expect(Priority.P3).toBe(3);
  });
});

describe("Priority conversion utilities", () => {
  test("converts numbers to Priority", () => {
    expect(toPriority(-1)).toBe(Priority.P0);
    expect(toPriority(0)).toBe(Priority.P0);
    expect(toPriority(1)).toBe(Priority.P1);
    expect(toPriority(2)).toBe(Priority.P2);
    expect(toPriority(3)).toBe(Priority.P3);
    expect(toPriority(99)).toBe(Priority.P3);
  });

  test("converts Priority to name", () => {
    expect(priorityName(Priority.P0)).toBe("P0");
    expect(priorityName(Priority.P1)).toBe("P1");
    expect(priorityName(Priority.P2)).toBe("P2");
    expect(priorityName(Priority.P3)).toBe("P3");
  });
});

describe("StoredMessage type shape", () => {
  test("has required properties", () => {
    const sample: StoredMessage = {
      id: "1749990000000-0",
      payload: { message: "hello" },
      metadata: { event: "test.event" },
      timestamp: 1_749_990_000_000,
      priority: Priority.P1,
      acked: false,
    };

    expect(sample).toMatchObject({
      id: expect.any(String),
      payload: expect.any(Object),
      timestamp: expect.any(Number),
      priority: Priority.P1,
      acked: false,
    });
  });

  test("accepts optional metadata", () => {
    const sample: StoredMessage = {
      id: "1749990000000-0",
      payload: { message: "hello" },
      timestamp: 1_749_990_000_000,
      priority: Priority.P1,
      acked: false,
    };

    expect(sample.metadata).toBeUndefined();
  });
});
