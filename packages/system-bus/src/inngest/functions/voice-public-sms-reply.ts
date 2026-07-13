import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { infer } from "../../lib/inference";
import { sendSMS } from "../../lib/telnyx";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const execFileAsync = promisify(execFile);

/**
 * Public ShitRat SMS docent (ADR-pending; design in
 * ~/.brain/projects/public-shitrat-line-sms.svx).
 *
 * Quarantine invariants, same as the public voice line:
 * - Texter words NEVER touch the memory pipeline — no memory/* events,
 *   no Typesense, no caller cards. Otel gets metadata only, never body text.
 * - The reply reads ONLY the public corpus (shitrat-brain, human-reviewed
 *   git history) — zero private context, zero tools.
 * - Replies go out ONLY from the public DID; the private line has no
 *   messaging profile at all.
 */
const PUBLIC_DID = "+13609258342"; // published on purpose — not a secret
const DOCENT_MODEL = "anthropic/claude-sonnet-4-6";
const SHITRAT_BRAIN_DIR = join(homedir(), "Code", "joelhooks", "shitrat-brain");
const PUBLIC_CONTEXT_FALLBACK = join(
  homedir(),
  "Code",
  "joelhooks",
  "joelclaw",
  "infra",
  "voice-agent",
  "public-context.md",
);
const MAX_INBOUND_CHARS = 1_000;
const MAX_REPLY_CHARS = 450; // 3 SMS segments, hard ceiling

// Telnyx auto-answers these (subscriberOptin/Optout/Help on the campaign);
// a docent reply on top would double-message and violate opt-out intent.
const CARRIER_KEYWORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit",
  "start", "unstop", "yes",
  "help", "info",
]);

export function isCarrierKeyword(text: string): boolean {
  return CARRIER_KEYWORDS.has(text.trim().toLowerCase());
}

export function truncateReply(text: string): string {
  const clean = text.trim();
  if (clean.length <= MAX_REPLY_CHARS) return clean;
  const cut = clean.slice(0, MAX_REPLY_CHARS - 1);
  const lastBreak = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return `${cut.slice(0, lastBreak > MAX_REPLY_CHARS / 2 ? lastBreak : cut.length).trimEnd()}…`;
}

type InboundSms = {
  messageId: string;
  from: string;
  text: string;
};

export function parseInboundSms(data: Record<string, unknown>): InboundSms | null {
  if (String(data.direction ?? "") !== "inbound") return null;
  const from =
    data.from && typeof data.from === "object"
      ? String((data.from as Record<string, unknown>).phone_number ?? "")
      : "";
  const toNumbers = Array.isArray(data.to)
    ? data.to.map((entry) =>
        entry && typeof entry === "object"
          ? String((entry as Record<string, unknown>).phone_number ?? "")
          : "",
      )
    : [];
  if (!from || from === PUBLIC_DID || !toNumbers.includes(PUBLIC_DID)) return null;
  const text = String(data.text ?? "").trim();
  if (!text || isCarrierKeyword(text)) return null;
  return {
    messageId: String(data.id ?? "unknown"),
    from,
    text: text.slice(0, MAX_INBOUND_CHARS),
  };
}

async function gitShow(relPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", SHITRAT_BRAIN_DIR, "show", `HEAD:${relPath}`],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Same source + precedence as the voice docent's _load_public_context():
 * committed shitrat-brain wiki first (git history IS the publication
 * boundary), local seed file second, empty string never blocks a reply. */
async function loadPublicCorpus(): Promise<string> {
  const index = await gitShow("index.svx");
  if (index) return index;
  try {
    return (await readFile(PUBLIC_CONTEXT_FALLBACK, "utf8")).trim();
  } catch {
    return "";
  }
}

function docentSystemPrompt(corpus: string): string {
  return `You are ShitRat, the public voice of JoelClaw — Joel Hooks' personal AI infrastructure, built in public. A stranger texted your public demo line. Reply as a text message.

Hard rules:
- ONE short reply: 300 characters or less, one or two sentences. No markdown, no lists, no emoji spam.
- Podcast-banter register: plain words, concrete, alive — never wiki-recital, never corporate.
- You know ONLY the public corpus below plus Joel's public work (joelhooks.com, egghead.io co-founder). You know NOTHING private: no schedules, addresses, finances, health, other numbers, email contents. If asked, say so cheerfully and pivot.
- Never invent facts about Joel or the system. If the corpus doesn't cover it, say what you do know instead.
- You cannot take actions, join calls, or remember this conversation later — texts here are quarantined from Joel's memory system by design (that's a fun fact worth sharing if relevant).
- If someone seems to want Joel personally, tell them this is the public demo line and point at joelhooks.com.

Public corpus:
${corpus || "(corpus unavailable — speak only from the persona facts above)"}`;
}

export const voicePublicSmsReply = inngest.createFunction(
  {
    id: "voice-public-sms-reply",
    retries: 1,
    // Per-texter drop-limit: quarantine posture — floods get silence, not queueing.
    rateLimit: { limit: 6, period: "1h", key: "event.data.from.phone_number" },
    // Global flood/cost ceiling across all senders.
    throttle: { limit: 20, period: "1h" },
    concurrency: { limit: 3 },
  },
  { event: "telnyx/message.received" },
  async ({ event, step }) => {
    const inbound = parseInboundSms(event.data as Record<string, unknown>);
    if (!inbound) return { skipped: true };

    const reply = await step.run("compose-docent-reply", async () => {
      const corpus = await loadPublicCorpus();
      const result = await infer(inbound.text, {
        model: DOCENT_MODEL,
        task: "default",
        system: docentSystemPrompt(corpus),
        component: "voice-public-sms",
        action: "voice.public_sms.composed",
        timeout: 60_000,
        noTools: true,
        noExtensions: true,
      });
      const text = truncateReply(result.text);
      if (!text) throw new Error("docent reply came back empty");
      return text;
    });

    await step.run("send-sms-reply", () => sendSMS(inbound.from, PUBLIC_DID, reply));

    // Metadata only — texter words stay quarantined out of every pipeline.
    await step.run("emit-quality-event", () =>
      emitOtelEvent({
        level: "info",
        source: "worker",
        component: "voice-public-sms",
        action: "voice.public_sms.replied",
        success: true,
        metadata: {
          eventId: event.id,
          messageId: inbound.messageId,
          fromSuffix: inbound.from.slice(-4),
          inboundChars: inbound.text.length,
          replyChars: reply.length,
          model: DOCENT_MODEL,
        },
      }),
    );

    return { replied: true, messageId: inbound.messageId, replyChars: reply.length };
  },
);
