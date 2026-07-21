import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDayPage, readReplayDay } from "./journal-spool-source.mjs";
import { validateAndBuildReceipts } from "./replay-core.mjs";

const event = (overrides) => ({
  journal_event_id: "event-1",
  flow_id: "flow-1",
  message_key: "telegram:flow-1:requested",
  occurred_at: "2026-07-20 01:00:00.000",
  recorded_at: "2026-07-20 01:00:00.000",
  direction: "outbound",
  event_type: "message.outbound.requested",
  producer: "test",
  channel: "telegram",
  classification: "unclassified",
  text: "one",
  transport_text: "one",
  ...overrides,
});

test("journal spool adapter paginates and pairs terminal receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-replay-"));
  try {
    await writeFile(join(directory, "a.json"), JSON.stringify(event({})));
    await writeFile(join(directory, "b.json"), JSON.stringify(event({ journal_event_id: "event-2", flow_id: "flow-2", message_key: "telegram:flow-2:requested", occurred_at: "2026-07-20 02:00:00.000", text: "two" })));
    await writeFile(join(directory, "c.json"), JSON.stringify(event({ journal_event_id: "event-3", event_type: "message.outbound.confirmed", occurred_at: "2026-07-20 03:00:00.000", transport_text: "sent one" })));
    await writeFile(join(directory, "d.json"), JSON.stringify(event({ journal_event_id: "event-4", event_type: "message.outbound.failed", occurred_at: "2026-07-20 04:00:00.000", error_code: "LATE_FAILURE" })));
    const first = await readDayPage({ day: "2026-07-20", directory, limit: 2 });
    assert.equal(first.events.length, 2);
    assert.equal(first.nextCursor, "2");
    const replay = await readReplayDay({ day: "2026-07-20", directory, pageSize: 2 });
    assert.equal(replay.inputCount, 2);
    assert.equal(replay.inputs[0].actual.deliveryState, "failed");
    assert.equal(replay.inputs[0].actual.errorCode, "LATE_FAILURE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt validation requires exact coverage", () => {
  const inputs = [
    { alias: "m001", inputEventId: "event-1" },
    { alias: "m002", inputEventId: "event-2" },
  ];
  const receipts = validateAndBuildReceipts({ decisions: [{ decision: "aggregate", reason: "One storm.", inputIds: ["m001", "m002"], rewrite: "One message." }] }, inputs, "2026-07-21T00:00:00.000Z");
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].inputEventIds, ["event-1", "event-2"]);
  const changed = validateAndBuildReceipts({ decisions: [{ decision: "aggregate", reason: "One storm.", inputIds: ["m001", "m002"], rewrite: "Changed message." }] }, inputs, "2026-07-21T00:00:00.000Z");
  assert.notEqual(receipts[0].receiptId, changed[0].receiptId);
  assert.equal(receipts[0].aggregateId, changed[0].aggregateId);
  assert.throws(() => validateAndBuildReceipts({ decisions: [{ decision: "hold", reason: "Duplicate.", inputIds: ["m001"], rewrite: null }] }, inputs, "2026-07-21T00:00:00.000Z"), /Missing input coverage/u);
});
