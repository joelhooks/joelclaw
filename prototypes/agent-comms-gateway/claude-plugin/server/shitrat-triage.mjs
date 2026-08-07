import { createPiProcessPool } from "../../../../packages/gateway/src/lib/pi-process-pool.ts";

export const SHITRAT_TRIAGE_MODEL = "openai-codex/gpt-5.6-luna";
const DISPOSITIONS = new Set(["social", "answer", "work"]);

let defaultPool;

function getDefaultPool() {
  defaultPool ??= createPiProcessPool({
    model: SHITRAT_TRIAGE_MODEL,
    timeoutMs: 12_000,
    maxIdleMs: 10 * 60_000,
  });
  return defaultPool;
}

export function warmShitratTriage() {
  getDefaultPool();
}

function inferWithLuna(prompt) {
  return getDefaultPool().infer(prompt);
}

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseJsonObject(raw) {
  const text = nonEmpty(raw, "Luna response")
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Luna triage returned no JSON object");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Luna triage returned invalid JSON");
  }
  return parsed;
}

function promptFor(input) {
  return `You are ShitRat, Joel's sharp technical familiar, triaging one Slack :shitrat: activation.

The token may be a real request, a direct question, attribution, a joke, or social chatter. Do not treat the token alone as work.

Choose exactly one disposition:
- social: sharing, status, attribution, celebration, joke, or no request to act.
- answer: a direct question that can be answered from the supplied Slack text alone. Do not invent facts.
- work: asks to inspect, change, research, summarize, verify, debug, publish, or otherwise use repository/tools.

Write the first threaded reply as ShitRat. Plain language. ELI5 but technically honest. Terse, specific, mischievous, and technically awake. Sound like a sharp teammate in group chat, not a product or support bot. A concrete image, dry joke, or bit of edge beats generic cheerleading. Never open with "Nice", "Sounds good", or "Happy to help". Never refer to ShitRat in the third person or say it "approves". No corporate sludge, assistant voice, markdown headings, or tables. Slack mrkdwn is allowed. Max 320 characters. Do not say "Working on it." If disposition=work, say what you understood and what will happen next. If disposition=work and no repository binding exists, say the channel needs a project mapping before launch. If social, respond like a familiar in the room, not a ticket system.

Return JSON only:
{"disposition":"social|answer|work","reply":"...","task":"... or null","reason":"short classification reason"}

Channel: ${JSON.stringify(input.channelName)}
Repository binding available: ${input.bound ? "yes" : "no"}
Slack message: ${JSON.stringify(input.text)}
Thread context: ${JSON.stringify(input.threadText ?? "")}`;
}

export function createShitratTriage({ infer = inferWithLuna } = {}) {
  return {
    triage: async ({ channelName, text, threadText = "", bound = false }) => {
      const parsed = parseJsonObject(await infer(promptFor({
        channelName: nonEmpty(channelName, "channelName"),
        text: nonEmpty(text, "text"),
        threadText: typeof threadText === "string" ? threadText.slice(0, 4_000) : "",
        bound: bound === true,
      })));
      const disposition = typeof parsed.disposition === "string"
        ? parsed.disposition.trim().toLowerCase()
        : "";
      if (!DISPOSITIONS.has(disposition)) {
        throw new Error(`Luna triage returned invalid disposition: ${disposition || "missing"}`);
      }
      const reply = nonEmpty(parsed.reply, "Luna reply");
      if (reply.length > 320) throw new Error("Luna triage reply exceeds 320 characters");
      const task = typeof parsed.task === "string" && parsed.task.trim()
        ? parsed.task.trim()
        : null;
      if (disposition === "work" && !task) {
        throw new Error("Luna work triage returned no task");
      }
      return {
        model: SHITRAT_TRIAGE_MODEL,
        disposition,
        reply,
        task,
        reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 240) : "",
      };
    },
  };
}
