/**
 * skill-tracker — OTEL instrumentation for skill reads in pi sessions.
 *
 * Intercepts `read` tool calls targeting SKILL.md files and emits
 * structured telemetry. Enables data-driven skill pruning: query
 * `joelclaw otel search "skill.read"` to see actual usage patterns.
 *
 * Emits: skill.read (per skill load)
 * Metadata: { skill, path, session_source }
 */

import type { PiExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";

const JOELCLAW_BIN = process.env.JOELCLAW_BIN || "joelclaw";
const SOURCE = process.env.GATEWAY_ROLE || "interactive";

// Debounce: don't emit for the same skill within 30s (model sometimes re-reads)
const recentReads = new Map<string, number>();
const DEBOUNCE_MS = 30_000;

function emitOtel(
  skillName: string,
  skillPath: string,
): void {
  const args = [
    "otel", "emit", "skill.read",
    "--source", SOURCE,
    "--component", "skill-tracker",
    "--level", "info",
    "--json",
    "--success", "true",
    "--metadata", JSON.stringify({
      skill: skillName,
      path: skillPath,
      session_source: SOURCE,
    }),
  ];

  const child = spawn(JOELCLAW_BIN, args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function extractSkillName(filePath: string): string | null {
  // Match paths like:
  //   ~/.pi/agent/skills/gateway/SKILL.md
  //   ~/Code/joelhooks/joelclaw/skills/adr-skill/SKILL.md
  //   ~/.agents/skills/pdf/SKILL.md
  //   /any/path/skills/name/SKILL.md
  const normalized = filePath.replace(/\/+/g, "/");

  if (!normalized.endsWith("/SKILL.md") && !normalized.endsWith("/SKILL.md".toLowerCase())) {
    return null;
  }

  // Skill name is the parent directory of SKILL.md
  const parent = basename(dirname(normalized));
  if (!parent || parent === "." || parent === "skills") return null;

  return parent;
}

export default function skillTracker(pi: PiExtensionContext) {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("read", event)) return;

    const filePath = event.input.path;
    const skillName = extractSkillName(filePath);
    if (!skillName) return;

    // Debounce
    const now = Date.now();
    const lastRead = recentReads.get(skillName);
    if (lastRead && now - lastRead < DEBOUNCE_MS) return;
    recentReads.set(skillName, now);

    // Prune old entries periodically
    if (recentReads.size > 200) {
      for (const [key, ts] of recentReads) {
        if (now - ts > DEBOUNCE_MS * 2) recentReads.delete(key);
      }
    }

    emitOtel(skillName, filePath);
  });
}
