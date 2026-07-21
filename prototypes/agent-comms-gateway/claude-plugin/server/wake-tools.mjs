import { runJson } from "./process.mjs";

function required(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

export function createWakeTools({ run = runJson } = {}) {
  return {
    revive: ({ loopId, reply, delay = "1s" }) =>
      run("joelclaw", [
        "wake",
        "in",
        delay,
        "--verb",
        "revive",
        "--loop",
        required(loopId, "loopId"),
        "--prompt",
        required(reply, "reply"),
        "--format",
        "json",
      ]),
    scheduleAggregateDeadline: ({ target, holdUntil, aggregateId, memberEventIds }) => {
      const timestamp = new Date(holdUntil);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= Date.now()) {
        throw new Error("holdUntil must be a future timestamp");
      }
      if (!Array.isArray(memberEventIds) || memberEventIds.length === 0) {
        throw new Error("memberEventIds must not be empty");
      }
      const prompt = JSON.stringify({
        kind: "aggregate.deadline.reached",
        aggregateId: required(aggregateId, "aggregateId"),
        memberEventIds,
        holdUntil: timestamp.getTime(),
      });
      return run("joelclaw", [
        "wake",
        "at",
        timestamp.toISOString(),
        "--verb",
        "wake",
        "--target",
        required(target, "target"),
        "--prompt",
        prompt,
        "--format",
        "json",
      ]);
    },
    list: () => run("joelclaw", ["wake", "list", "--format", "json"]),
    cancel: ({ scheduleId }) =>
      run("joelclaw", ["wake", "cancel", required(scheduleId, "scheduleId"), "--format", "json"]),
  };
}
