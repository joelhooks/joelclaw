import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fenced(value) {
  const text = String(value ?? "").trim() || "(empty)";
  const fence = text.includes("````") ? "`````" : text.includes("```") ? "````" : "```";
  return `${fence}text\n${text}\n${fence}`;
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function buildReviewNote(replay, receipts, generatedAt) {
  const inputById = new Map(replay.inputs.map((input) => [input.inputEventId, input]));
  const counts = Object.fromEntries(["deliver", "hold", "aggregate", "escalate"].map((decision) => [
    decision,
    receipts.filter((receipt) => receipt.decision === decision).length,
  ]));
  const covered = receipts.reduce((sum, receipt) => sum + receipt.inputEventIds.length, 0);
  const actualConfirmed = replay.inputs.filter((input) => input.actual.deliveryState === "confirmed").length;

  const sections = receipts.map((receipt, index) => {
    const inputs = receipt.inputEventIds.map((id) => inputById.get(id)).filter(Boolean);
    const first = inputs[0];
    const actual = inputs.map((input) =>
      `### ${input.alias} · ${input.occurredAt} · actual ${input.actual.deliveryState}\n\n` +
      `${fenced(input.actual.text || input.text)}\n`).join("\n");
    const proposed = receipt.rewrite ? fenced(receipt.rewrite) : "_No delivery._";
    return `## ${index + 1}. ${receipt.decision.toUpperCase()} · ${inputs.length} input${inputs.length === 1 ? "" : "s"}\n\n` +
      `**Reason:** ${oneLine(receipt.reason)}\n\n` +
      `${receipt.aggregateId ? `**Storm:** \`${receipt.aggregateId}\`\n\n` : ""}` +
      `### What actually arrived\n\n${actual}\n` +
      `### What the gateway would do\n\n${proposed}\n\n` +
      `Receipt: \`${receipt.receiptId}\` · target: \`${receipt.targetIntent ?? "none"}\`\n`;
  }).join("\n---\n\n");

  return `---\ntitle: "Decision-loop replay review: ${replay.day}"\ntype: "review"\ncreated_at: "${generatedAt.slice(0, 10)}"\nprivacy: "private"\nsource: ".brain/data/agent-comms-gateway/replay-${replay.day}/"\n---\n\n# Decision-loop replay review: ${replay.day}\n\nThis is a read-only replay of one real journal day. Nothing below was sent.\n\n## What to react to\n\n- Which message did the gateway wrongly hold?\n- Which message did it wrongly deliver?\n- Which storm grouping is wrong?\n- Which rewrite does not sound right?\n- Did anything deserve a phone call?\n\n## Replay receipt\n\n| Fact | Value |\n| --- | ---: |\n| Journal events read | ${replay.journalEventCount} |\n| Producer messages replayed | ${replay.inputCount} |\n| Actually confirmed | ${actualConfirmed} |\n| Inputs covered by decisions | ${covered} |\n| Deliver receipts | ${counts.deliver} |\n| Hold receipts | ${counts.hold} |\n| Aggregate receipts | ${counts.aggregate} |\n| Escalate receipts | ${counts.escalate} |\n\nSource: \`${replay.source}\` through the paginated \`${replay.readContract}\` adapter shape.\n\nGenerated: ${generatedAt}. Prompt revision: \`${receipts[0]?.promptRevision ?? "unknown"}\`.\n\n${sections}\n`;
}

async function main() {
  const [inputPath, receiptsPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !receiptsPath || !outputPath) {
    throw new Error("Usage: render-review.mjs <input.json> <decisions.json> <output.svx>");
  }
  const replay = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  const receipts = JSON.parse(await readFile(resolve(receiptsPath), "utf8"));
  await writeFile(resolve(outputPath), buildReviewNote(replay, receipts, new Date().toISOString()), "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
