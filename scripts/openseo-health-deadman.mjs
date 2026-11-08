import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeHealthCommand,
  fallbackConfig,
  publishReport,
  scrub,
} from "./openseo-nightly-health.mjs";

// Independent scheduler and query: a crashed/disabled main job cannot renew its
// own heartbeat. Dead-man events use another component and never count as main.
export function assessHeartbeat(envelope) {
  if (envelope.ok !== true || !Number.isInteger(envelope.result?.found)) {
    throw new Error(
      `OpenSEO heartbeat query failed: ${scrub(envelope.error?.message ?? "invalid receipt")}`,
    );
  }
  return { ok: envelope.result.found > 0, found: envelope.result.found };
}

export async function main() {
  let config = fallbackConfig();
  try {
    const parsed = JSON.parse(
      await readFile(process.env.OPENSEO_HEALTH_CONFIG, "utf8"),
    );
    for (const key of Object.keys(config))
      if (typeof parsed[key] === "string" && parsed[key])
        config[key] = parsed[key];
    const output = await executeHealthCommand(config.joelclaw, [
      "otel",
      "list",
      "--component",
      "openseo-nightly-health",
      "--hours",
      "26",
      "--limit",
      "1",
    ]);
    const checked = assessHeartbeat(JSON.parse(output));
    if (checked.ok) {
      console.info(JSON.stringify({ ok: true, heartbeatPresent: true }));
      return;
    }
    throw new Error(
      "No openseo.health.checked event from the main nightly job in 26 hours",
    );
  } catch (error) {
    await mkdir(config.reportDir, { recursive: true, mode: 0o700 });
    const receiptPath = join(config.reportDir, "deadman-alarm.json");
    let previous;
    try {
      previous = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch {
      /* No prior delivered alarm. */
    }
    const message = scrub(error.message);
    if (
      previous?.error === message &&
      previous?.delivered === true &&
      Date.now() - Date.parse(previous.timestamp) < 24 * 60 * 60 * 1000
    ) {
      console.info(JSON.stringify({ ok: false, alarmAlreadyDelivered: true }));
      process.exitCode = 1;
      return;
    }
    const report = await publishReport(config, {
      ok: false,
      component: "openseo-health-deadman",
      action: "openseo.health.heartbeat.missing",
      error: message,
      phase: "deadman",
      warnings: [],
      healAttempted: false,
      duration_ms: 0,
    });
    await writeFile(
      receiptPath,
      JSON.stringify({
        error: message,
        delivered: report.notification.delivered,
        timestamp: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(scrub(error.message));
    process.exitCode = 1;
  });
}
