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

export const dailyDigest = inngest.createFunction(
  {
    id: "memory/digest-daily",
    name: "Generate Daily Digest",
    retries: 1,
    concurrency: { limit: 1 },
  },
  [{ cron: "55 7 * * *" }, { event: "memory/digest.requested" }],
  async ({ step }) => {
    const date = losAngelesIsoDate();
    const home = getHomeDirectory();
    const sourcePath = join(home, ".joelclaw", "workspace", "memory", `${date}.md`);
    const sourceFrontmatterPath = `~/.joelclaw/workspace/memory/${date}.md`;
    const digestPath = join(home, "Vault", "Daily", "digests", `${date}-digest.md`);

    const alreadyExists = await step.run("check-digest-exists", async () => existsSync(digestPath));
    if (alreadyExists) {
      return { status: "noop", reason: "digest already exists", date, digestPath };
    }

    const rawLog = await step.run("read-daily-log", async () => {
      const file = Bun.file(sourcePath);
      if (!(await file.exists())) return "";
      return (await file.text()).trim();
    });

    if (!rawLog) {
      return { status: "noop", reason: "daily log missing or empty", date, sourcePath };
    }

    const digestPrompt = DIGEST_USER_PROMPT(date, rawLog);

    const digestText = await step.run("generate-digest", async () => {
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

      const text = stripMarkdownFences(result.text.trim());
      if (!text) {
        throw new Error("Digest generation returned empty output");
      }

      return text;
    });

    await step.run("write-digest-file", async () => {
      mkdirSync(dirname(digestPath), { recursive: true });
      const content = buildDigestFileContent(date, sourceFrontmatterPath, digestText);
      await Bun.write(digestPath, content);
    });

    await step.sendEvent("emit-digest-created", {
      name: "memory/digest.created",
      data: {
        date,
        sourcePath,
        digestPath,
      },
    });

    return { status: "created", date, sourcePath, digestPath };
  }
);
