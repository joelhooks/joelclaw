import { createPiProcessPool } from "../../../../packages/gateway/src/lib/pi-process-pool.ts";

export const SHITRAT_TRIAGE_MODEL = "openai-codex/gpt-5.6-luna";
const DISPOSITIONS = new Set(["social", "answer", "work", "resolve"]);

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
- resolve: a human clearly closes the active thread: done, shipped, fixed, thanks that's all, or equivalent. Do not use resolve for an ordinary acknowledgement while work remains open.

Write the first threaded reply as ShitRat. Plain language. ELI5 but technically honest. Terse, specific, mischievous, and technically awake. Sound like a sharp teammate in group chat, not a product or support bot. A concrete image, dry joke, or bit of edge beats generic cheerleading. Never open with "Nice", "Sounds good", or "Happy to help". Never refer to ShitRat in the third person or say it "approves". No corporate sludge, assistant voice, markdown headings, or tables. Slack mrkdwn is allowed. Max 320 characters. Do not say "Working on it." If disposition=work, say what you understood and what will happen next. If disposition=work and no repository binding exists, say the channel needs a project mapping before launch. If social, respond like a familiar in the room, not a ticket system.

Return JSON only:
{"disposition":"social|answer|work|resolve","reply":"...","task":"... or null","reason":"short classification reason","projectId":"candidate id or null","projectConfidence":0.0}

Channel: ${JSON.stringify(input.channelName)}
Activation: ${JSON.stringify(input.activation ?? "new")}
Repository binding available: ${input.bound ? "yes" : "no"}
Verified project candidates: ${JSON.stringify(input.projectCandidates ?? [])}
Choose a projectId only when one candidate clearly matches the supplied Slack evidence. Never invent a repository. A channel candidate is useful evidence, not automatic truth. Keep projectConfidence between 0 and 1.
Slack message: ${JSON.stringify(input.text)}
Thread context: ${JSON.stringify(input.threadText ?? "")}`;
}

export function createShitratTriage({ infer = inferWithLuna } = {}) {
  return {
    triage: async ({
      channelName,
      text,
      threadText = "",
      bound = false,
      activation = "new",
      projectCandidates = [],
    }) => {
      const candidates = Array.isArray(projectCandidates)
        ? projectCandidates
            .filter((candidate) => candidate && typeof candidate === "object")
            .slice(0, 20)
            .map((candidate) => ({
              id: String(candidate.id ?? "").slice(0, 80),
              label: String(candidate.label ?? "").slice(0, 120),
              root: String(candidate.root ?? "").slice(0, 240),
              source: String(candidate.source ?? "").slice(0, 40),
            }))
            .filter((candidate) => candidate.id && candidate.root)
        : [];
      const parsed = parseJsonObject(await infer(promptFor({
        channelName: nonEmpty(channelName, "channelName"),
        text: nonEmpty(text, "text"),
        threadText: typeof threadText === "string" ? threadText.slice(-4_000) : "",
        bound: bound === true,
        activation: activation === "follow-up" ? "follow-up" : "new",
        projectCandidates: candidates,
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
      const candidateIds = new Set(candidates.map((candidate) => candidate.id));
      const projectId = typeof parsed.projectId === "string"
        && candidateIds.has(parsed.projectId.trim())
        ? parsed.projectId.trim()
        : null;
      const numericConfidence = Number(parsed.projectConfidence);
      const projectConfidence = Number.isFinite(numericConfidence)
        ? Math.max(0, Math.min(1, numericConfidence))
        : 0;
      return {
        model: SHITRAT_TRIAGE_MODEL,
        disposition,
        reply,
        task,
        reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 240) : "",
        projectId,
        projectConfidence,
      };
    },
  };
}
