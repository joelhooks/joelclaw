/**
 * ADR-0067: Pattern adapted from memory-curator by 77darius77 (openclaw/skills, MIT).
 *
 * Generate a structured daily digest from the raw memory log.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { infer } from "../../lib/inference";
import { inngest } from "../client";
import { DIGEST_SYSTEM_PROMPT, DIGEST_USER_PROMPT } from "./daily-digest-prompt";

function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || "/Users/joel";
}

function losAngelesIsoDate(now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function buildDigestFileContent(date: string, sourcePath: string, digestBody: string): string {
  return [
    "---",
    "type: digest",
    `date: ${date}`,
    `source: ${sourcePath}`,
    "---",
    "",
    stripMarkdownFences(digestBody),
    "",
  ].join("\n");
}

export async function runDailyDigest(now = new Date()) {
  const date = losAngelesIsoDate(now);
  const home = getHomeDirectory();
  const sourcePath = join(home, ".joelclaw", "workspace", "memory", `${date}.md`);
  const sourceFrontmatterPath = `~/.joelclaw/workspace/memory/${date}.md`;
  const digestPath = join(home, "Vault", "Daily", "digests", `${date}-digest.md`);

  if (existsSync(digestPath)) {
    return { status: "noop", reason: "digest already exists", date, digestPath };
  }

  const file = Bun.file(sourcePath);
  const rawLog = (await file.exists()) ? (await file.text()).trim() : "";

  if (!rawLog) {
    return { status: "noop", reason: "daily log missing or empty", date, sourcePath };
  }

  const digestPrompt = DIGEST_USER_PROMPT(date, rawLog);

  const result = await infer(digestPrompt, {
    task: "digest",
    component: "daily-digest",
    action: "memory.digest.generate",
    system: DIGEST_SYSTEM_PROMPT,
    metadata: {
      date,
    },
    timeout: 120_000,
  });

  const digestText = stripMarkdownFences(result.text.trim());
  if (!digestText) {
    throw new Error("Digest generation returned empty output");
  }

  mkdirSync(dirname(digestPath), { recursive: true });
  const content = buildDigestFileContent(date, sourceFrontmatterPath, digestText);
  await Bun.write(digestPath, content);

  let eventDispatched = true;
  try {
    await inngest.send({
      name: "memory/digest.created",
      data: {
        date,
        sourcePath,
        digestPath,
      },
    });
  } catch {
    eventDispatched = false;
  }

  return { status: "created", date, sourcePath, digestPath, eventDispatched };
}

export const dailyDigest = inngest.createFunction(
  {
    id: "memory/digest-daily",
    name: "Generate Daily Digest",
    retries: 1,
    concurrency: { limit: 1 },
  },
  [{ event: "memory/digest.requested" }],
  async ({ step }) => {
    return step.run("run-daily-digest", async () => runDailyDigest());
  }
);
