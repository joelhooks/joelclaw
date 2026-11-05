import { describe, expect, test } from "bun:test";
import { REDACTED_SECRET, redactSecrets } from "./observation-secrets";
import { sanitizeObservationText, sanitizeObservationTranscript } from "./observation-sanitize";
import { normalizeObservations } from "./observe-session-noted";

const run = (seed: string, length: number) => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
const hex = (length: number) => run("9f3a0c7be21d4856", length);
const alnum = (length: number) => run("Q7mZp2Lx9Tk4Wb8R", length);

const planted = {
  githubUser: ["ghu", alnum(36)].join("_"),
  githubPat: ["ghp", alnum(36)].join("_"),
  githubServer: ["ghs", alnum(36)].join("_"),
  openai: ["sk", "proj", alnum(40)].join("-"),
  anthropic: ["sk", "ant", "api03", alnum(48)].join("-"),
  inngestSigning: ["signkey", "prod", hex(64)].join("-"),
  inngestEvent: alnum(86),
  livekitKey: `API${alnum(12)}`,
  livekitSecret: alnum(43),
  jwt: ["eyJ" + alnum(20), "eyJ" + alnum(30), alnum(43)].join("."),
  aws: `AKIA${"Q7MZP2LX9TK4WB8R"}`,
  bearer: alnum(40),
};

describe("redactSecrets", () => {
  test.each([
    ["GitHub user token", `pushed with ${planted.githubUser} today`],
    ["GitHub PAT", `token ${planted.githubPat}`],
    ["GitHub server token", planted.githubServer],
    ["OpenAI key", `uses ${planted.openai} for embeddings`],
    ["Anthropic key", planted.anthropic],
    ["Inngest signing key", `requests signed with ${planted.inngestSigning} pass`],
    ["Inngest event key", `INNGEST_EVENT_KEY=${planted.inngestEvent}`],
    ["Inngest event key in prose", `the inngest event key is ${planted.inngestEvent}`],
    ["LiveKit API key", `LIVEKIT_API_KEY="${planted.livekitKey}"`],
    ["LiveKit secret", `livekit_api_secret: ${planted.livekitSecret}`],
    ["JWT", `session cookie ${planted.jwt}`],
    ["AWS key", planted.aws],
    ["Bearer token", `Authorization: Bearer ${planted.bearer}`],
  ])("masks %s", (_name, input) => {
    const output = redactSecrets(input);
    expect(output).toContain(REDACTED_SECRET);
    for (const value of Object.values(planted)) {
      expect(output).not.toContain(value);
    }
  });

  test("masks a PEM private key across lines", () => {
    const pem = [["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" "), alnum(70), alnum(70), ["-----END", "OPENSSH", "PRIVATE", "KEY-----"].join(" ")].join("\n");
    expect(redactSecrets(`key:\n${pem}\ndone`)).toBe(`key:\n${REDACTED_SECRET}\ndone`);
  });

  test("leaves ordinary observation prose alone", () => {
    const prose = [
      "Joel prefers pnpm over npm; the token budget was 150000 and the secret santa list is done.",
      "Commit 9396d92 merged the executor log rotation; auth: requiredForAllRoutes on every route.",
      "The password reset flow lives in apps/web/app/reset.",
      "Usage so far: tokens: 1500000000000 across the week.",
    ].join("\n");
    expect(redactSecrets(prose)).toBe(prose);
  });
});

describe("observer capture paths mask planted keys", () => {
  const line = `Assistant: set INNGEST_EVENT_KEY=${planted.inngestEvent} and LIVEKIT_API_SECRET=${planted.livekitSecret}, pushed with ${planted.githubUser}.`;

  test("the transcript sent to the observer model", () => {
    const sanitized = sanitizeObservationTranscript(`User: deploy it\n${line}`);
    expect(sanitized).toContain(REDACTED_SECRET);
    for (const value of [planted.inngestEvent, planted.livekitSecret, planted.githubUser]) {
      expect(sanitized).not.toContain(value);
    }
  });

  test("an observation fact before it is stored", () => {
    const fact = sanitizeObservationText(`The worker reads INNGEST_EVENT_KEY=${planted.inngestEvent} from env.`);
    expect(fact).not.toBeNull();
    expect(fact).not.toContain(planted.inngestEvent);
  });

  test("a session/observation.noted summary before it is indexed", () => {
    const docs = normalizeObservations([{ summary: `LiveKit secret is ${planted.livekitSecret}` }], "evt-1");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.observation).not.toContain(planted.livekitSecret);
    expect(docs[0]?.observation).toContain(REDACTED_SECRET);
  });
});
