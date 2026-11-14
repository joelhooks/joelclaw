import {
  isRatKingName,
  type NotifyAgentInput,
  notifyAgent,
} from "../packages/system-bus/src/lib/notify-agent";

/** Operator-only receipt check. Every route is redirected to the explicit test recipient. */
export async function runAgentSynthetic(
  argv: string[],
  send: (input: NotifyAgentInput) => Promise<void> = notifyAgent,
): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--to" || !isRatKingName(argv[1])) {
    throw new Error("Usage: bun scripts/notify-agent-synthetic.ts --to <ratking-name>");
  }
  for (const source of [
    "daily-token-usage-report",
    "self-healing-backup-blocked",
    "self-healing-retry-exhausted",
    "self-healing-escalated",
    "wiki-edition-build",
  ]) {
    await send({
      to: argv[1],
      source,
      summary: `[TEST] ${source}`,
      message: `[TEST] Synthetic agent notification for ${source}. No action required.`,
      ...(source === "daily-token-usage-report" ? { quiet: true } : {}),
    });
  }
}

if (import.meta.main) await runAgentSynthetic(process.argv.slice(2));
