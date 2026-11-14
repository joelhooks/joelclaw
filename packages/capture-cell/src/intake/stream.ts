import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

export const MAX_INTAKE_BYTES = 2 * 1024 ** 3;
const MAX_METADATA_CHARS = 64 * 1024;

export class IntakeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function invalid(): never {
  throw new IntakeRequestError(400, "invalid_run_capture");
}

export function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("blob write made no progress");
    offset += written;
  }
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Extract only the top-level jsonl string. JSON.parse validates the bounded
 * remainder. Escapes, UTF-8 and surrogate pairs may cross transport chunks. */
class BodyDecoder {
  private state: "start" | "key" | "colon" | "value" | "other" | "jsonl" | "separator" | "end" =
    "start";
  private metadata = "";
  private keyText = "";
  private key: string | null = null;
  private quoted = false;
  private escaped = false;
  private depth = 0;
  private seenJsonl = false;
  private escape = "";
  private surrogate = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  // eslint-disable-next-line no-control-regex -- Reject raw controls forbidden inside JSON strings.
  private readonly special = /["\\\x00-\x1f]/gu;
  constructor(private readonly sink: (bytes: Uint8Array) => void) {}
  private meta(text: string): void {
    this.metadata += text;
    if (this.metadata.length > MAX_METADATA_CHARS)
      throw new IntakeRequestError(413, "metadata_too_large");
  }
  push(bytes: Uint8Array, final = false): void {
    const text = this.decoder.decode(bytes, { stream: !final });
    const output: string[] = [];
    for (let i = 0; i < text.length; ) {
      const c = text[i]!;
      if (this.state === "jsonl") {
        if (this.escape) {
          this.escape += c;
          i++;
          if (this.escape.length === 2 && c !== "u") {
            const escapes: Record<string, string> = {
              '"': '"',
              "\\": "\\",
              "/": "/",
              b: "\b",
              f: "\f",
              n: "\n",
              r: "\r",
              t: "\t",
            };
            if (!(c in escapes)) invalid();
            output.push(escapes[c]!);
            this.escape = "";
          } else if (this.escape.length === 6) {
            if (!/^\\u[0-9a-f]{4}$/iu.test(this.escape)) invalid();
            output.push(String.fromCharCode(Number.parseInt(this.escape.slice(2), 16)));
            this.escape = "";
          }
          continue;
        }
        this.special.lastIndex = i;
        const match = this.special.exec(text);
        const end = match?.index ?? text.length;
        output.push(text.slice(i, end));
        i = end;
        if (!match) continue;
        i++;
        if (match[0] === '"') this.state = "separator";
        else if (match[0] === "\\") this.escape = "\\";
        else invalid();
        continue;
      }
      this.meta(c);
      if (this.state === "start") {
        if (!/\s/u.test(c)) {
          if (c !== "{") invalid();
          this.state = "key";
        }
      } else if (this.state === "key") {
        if (this.quoted) {
          this.keyText += c;
          if (this.escaped) this.escaped = false;
          else if (c === "\\") this.escaped = true;
          else if (c === '"') {
            this.key = JSON.parse(this.keyText) as string;
            this.keyText = "";
            this.quoted = false;
            this.state = "colon";
          }
        } else if (!/\s/u.test(c)) {
          if (c === "}") this.state = "end";
          else {
            if (c !== '"') invalid();
            this.quoted = true;
            this.keyText = '"';
          }
        }
      } else if (this.state === "colon") {
        if (!/\s/u.test(c)) {
          if (c !== ":") invalid();
          this.state = "value";
        }
      } else if (this.state === "value") {
        if (!/\s/u.test(c)) {
          if (this.key === "jsonl") {
            if (c !== '"' || this.seenJsonl) invalid();
            this.seenJsonl = true;
            this.meta('"'); // metadata substitutes jsonl: ""
            this.state = "jsonl";
          } else {
            this.state = "other";
            this.other(c);
          }
        }
      } else if (this.state === "other") this.other(c);
      else if (this.state === "separator") {
        if (!/\s/u.test(c)) {
          if (c === ",") this.state = "key";
          else if (c === "}") this.state = "end";
          else invalid();
        }
      } else if (!/\s/u.test(c)) invalid();
      i++;
    }
    let decoded = this.surrogate + output.join("");
    this.surrogate = "";
    if (!final && decoded.length) {
      const last = decoded.charCodeAt(decoded.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.surrogate = decoded.slice(-1);
        decoded = decoded.slice(0, -1);
      }
    }
    if (decoded) this.sink(Buffer.from(decoded, "utf8"));
  }
  private other(c: string): void {
    if (this.quoted) {
      if (this.escaped) this.escaped = false;
      else if (c === "\\") this.escaped = true;
      else if (c === '"') this.quoted = false;
    } else if (c === '"') this.quoted = true;
    else if (c === "{" || c === "[") this.depth++;
    else if (c === "}" || c === "]") {
      if (this.depth === 0) this.state = "end";
      else this.depth--;
    } else if (c === "," && this.depth === 0) this.state = "key";
  }
  finish(): Record<string, unknown> {
    this.push(new Uint8Array(), true);
    if (this.state !== "end" || !this.seenJsonl || this.escape) invalid();
    const metadata: unknown = JSON.parse(this.metadata);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalid();
    return metadata as Record<string, unknown>;
  }
}

export async function receiveInlineBody(
  request: Request,
  fd: number,
  maxBytes = MAX_INTAKE_BYTES,
): Promise<{
  metadata: Record<string, unknown>;
  bytes: number;
  sha256: string;
}> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes))
    throw new IntakeRequestError(413, "body_too_large");
  if (!request.body) invalid();
  const hash = createHash("sha256");
  let bytes = 0;
  let wireBytes = 0;
  const decoder = new BodyDecoder((chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new IntakeRequestError(413, "body_too_large");
    writeAll(fd, chunk);
    hash.update(chunk);
  });
  const reader = request.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      wireBytes += chunk.value.length;
      if (wireBytes > maxBytes) throw new IntakeRequestError(413, "body_too_large");
      for (let offset = 0; offset < chunk.value.length; offset += 64 * 1024) {
        decoder.push(chunk.value.subarray(offset, offset + 64 * 1024));
      }
    }
    const metadata = decoder.finish();
    if (!bytes) invalid();
    return { metadata, bytes, sha256: hash.digest("hex") };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof SyntaxError || error instanceof TypeError) invalid();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Fresh stream per retry; escape only one file chunk at a time. */
export function inlineBody(metadata: object, path: string): ReadableStream<Uint8Array> {
  const prefix = JSON.stringify(metadata);
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let phase: "prefix" | "blob" | "done" = "prefix";
  return new ReadableStream({
    async pull(controller) {
      try {
        if (phase === "prefix") {
          controller.enqueue(Buffer.from(`${prefix.slice(0, -1)},"jsonl":"`));
          phase = "blob";
          return;
        }
        const next = await reader.read();
        const text = decoder.decode(next.value, { stream: !next.done });
        if (text) controller.enqueue(Buffer.from(JSON.stringify(text).slice(1, -1)));
        if (next.done) {
          phase = "done";
          reader.releaseLock();
          controller.enqueue(Buffer.from('"}'));
          controller.close();
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      if (phase !== "done") await reader.cancel().catch(() => undefined);
    },
  });
}
