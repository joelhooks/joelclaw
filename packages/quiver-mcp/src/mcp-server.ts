import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { QuiverError, type QuiverClient, type SvgResponse } from "./quiver-client.ts";

export const SERVER_NAME = "quiver-mcp";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_OUT_DIR = "/Users/joel/.joelclaw/quiver-out";
export const DEFAULT_GENERATE_MODEL = "arrow-1.1";
export const DEFAULT_VECTORIZE_MODEL = "arrow-2";
/** SVG markup up to this many bytes is returned inline; larger output is file-only. */
export const INLINE_SVG_LIMIT = 64 * 1024;
/** Quiver's documented decoded-image ceiling for vectorization. */
export const MAX_IMAGE_BYTES = 12_582_912;
const MAX_OUTPUTS = 4;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export interface QuiverMcpOptions {
  readonly client: QuiverClient;
  readonly outDir?: string;
  /** Clock for output file names (tests). */
  readonly now?: () => Date;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const SPEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const ReasoningEffort = z.enum(["low", "medium", "high", "xhigh"]);
const FileStem = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "lowercase letters, digits, and dashes only")
  .describe("File stem for saved output (default: derived from the prompt). Multiple outputs get -1, -2 suffixes.");

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const detail =
    error instanceof QuiverError
      ? error.toJSON()
      : { code: "tool_error", message: error instanceof Error ? error.message : "unknown error" };
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: detail }, null, 2) }], isError: true };
}

async function guarded(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    return fail(error);
  }
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replaceAll(/-+$/gu, "");
  return slug === "" ? "svg" : slug;
}

export function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}`;
}

export interface SavedSvg {
  readonly path: string;
  readonly bytes: number;
}

export async function saveSvgs(response: SvgResponse, outDir: string, stem: string): Promise<SavedSvg[]> {
  await mkdir(outDir, { recursive: true });
  const saved: SavedSvg[] = [];
  for (const [index, document] of response.data.entries()) {
    const suffix = response.data.length > 1 ? `-${index + 1}` : "";
    const path = join(outDir, `${stem}${suffix}.svg`);
    await writeFile(path, document.svg, { encoding: "utf8", flag: "wx" });
    saved.push({ path, bytes: Buffer.byteLength(document.svg, "utf8") });
  }
  return saved;
}

function summarize(response: SvgResponse, model: string, files: readonly SavedSvg[]) {
  const totalBytes = response.data.reduce((sum, document) => sum + Buffer.byteLength(document.svg, "utf8"), 0);
  const inline = totalBytes <= INLINE_SVG_LIMIT;
  return {
    ok: true,
    id: response.id,
    model,
    outputs: response.data.length,
    ...(response.credits === undefined ? {} : { credits: response.credits }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    files,
    ...(inline
      ? { svg: response.data.map((document) => document.svg) }
      : { svg: `omitted: ${totalBytes} bytes total; read the saved files` }),
  };
}

/** Read a local raster or SVG file for vectorization. Regular files only, no symlinks, size-capped. */
export async function readImageFile(input: string): Promise<{ readonly base64: string }> {
  if (!input.startsWith("/")) throw new Error("path must be absolute");
  const path = resolve(input);
  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (mediaType === undefined) {
    throw new Error(`unsupported image extension; use one of ${Object.keys(IMAGE_TYPES).join(", ")}`);
  }
  const stat = await lstat(path).catch(() => {
    throw new Error(`image does not exist: ${path}`);
  });
  if (!stat.isFile()) throw new Error(`image must be a regular file (no symlinks): ${path}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`image is ${stat.size} bytes; Quiver accepts at most ${MAX_IMAGE_BYTES}`);
  }
  const bytes = await readFile(path);
  return { base64: `data:${mediaType};base64,${bytes.toString("base64")}` };
}

export function createQuiverMcpServer(options: QuiverMcpOptions): McpServer {
  const { client } = options;
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const now = options.now ?? (() => new Date());
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "quiver_models",
    {
      title: "List Quiver models",
      description:
        "List the QuiverAI (Arrow) models this API key can use, with supported operations and per-operation credit prices. Call this before choosing a non-default model.",
      inputSchema: {},
      annotations: READ,
    },
    (_input, extra) => guarded(async () => ({ ok: true, models: await client.listModels(extra.signal) })),
  );

  server.registerTool(
    "quiver_generate_svg",
    {
      title: "Generate SVG from text",
      description: `Generate one or more SVGs from a text prompt with QuiverAI Arrow. Spends Quiver credits per output. Files are saved under ${outDir} and the paths are returned; markup is returned inline when the total is under ${INLINE_SVG_LIMIT} bytes. Default model ${DEFAULT_GENERATE_MODEL}; use arrow-1.1-max for dense technical diagrams.`,
      inputSchema: {
        prompt: z.string().min(1).max(4000).describe("What to draw. Be concrete about subject, style, and composition."),
        instructions: z
          .string()
          .max(4000)
          .optional()
          .describe("Style or formatting guidance, e.g. 'flat monochrome, clean geometry, no text'."),
        model: z.string().min(1).optional().describe(`Quiver model id (default ${DEFAULT_GENERATE_MODEL}).`),
        n: z.number().int().min(1).max(MAX_OUTPUTS).optional().describe("Number of variations (default 1, max 4)."),
        reasoningEffort: ReasoningEffort.optional().describe("Arrow reasoning effort; omit for the model default."),
        references: z
          .array(z.string().url())
          .max(4)
          .optional()
          .describe("Up to 4 public reference image URLs that guide style and composition."),
        filename: FileStem.optional(),
        save: z.boolean().optional().describe("Write .svg files to disk (default true)."),
      },
      annotations: SPEND,
    },
    (input, extra) =>
      guarded(async () => {
        const model = input.model ?? DEFAULT_GENERATE_MODEL;
        const response = await client.generate(
          {
            prompt: input.prompt,
            model,
            ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
            ...(input.n === undefined ? {} : { n: input.n }),
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
            ...(input.references === undefined ? {} : { references: input.references }),
          },
          extra.signal,
        );
        const stem = `${stamp(now())}-${input.filename ?? slugify(input.prompt)}`;
        const files = input.save === false ? [] : await saveSvgs(response, outDir, stem);
        return summarize(response, model, files);
      }),
  );

  server.registerTool(
    "quiver_vectorize_image",
    {
      title: "Convert an image to SVG",
      description: `Vectorize a raster image (PNG, JPEG, WebP, GIF) or re-trace an SVG with QuiverAI Arrow. Give exactly one of url or path. Spends Quiver credits. Output is saved under ${outDir}. Default model ${DEFAULT_VECTORIZE_MODEL}; arrow-2-telos keeps more detail.`,
      inputSchema: {
        url: z.string().url().optional().describe("Public HTTPS URL of the image."),
        path: z
          .string()
          .optional()
          .describe(`Absolute local file path (regular file, at most ${MAX_IMAGE_BYTES} bytes).`),
        model: z.string().min(1).optional().describe(`Quiver model id (default ${DEFAULT_VECTORIZE_MODEL}).`),
        autoCrop: z.boolean().optional().describe("Crop to the dominant subject first (default true)."),
        targetSize: z.number().int().min(128).max(4096).optional().describe("Square resize target in pixels."),
        reasoningEffort: ReasoningEffort.optional(),
        filename: FileStem.optional(),
        save: z.boolean().optional().describe("Write the .svg file to disk (default true)."),
      },
      annotations: SPEND,
    },
    (input, extra) =>
      guarded(async () => {
        if ((input.url === undefined) === (input.path === undefined)) {
          throw new Error("give exactly one of url or path");
        }
        const source = input.url ?? (input.path as string);
        const image = input.url === undefined ? await readImageFile(source) : { url: input.url };
        const model = input.model ?? DEFAULT_VECTORIZE_MODEL;
        const response = await client.vectorize(
          {
            model,
            image,
            autoCrop: input.autoCrop ?? true,
            ...(input.targetSize === undefined ? {} : { targetSize: input.targetSize }),
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
          },
          extra.signal,
        );
        const stem = `${stamp(now())}-${input.filename ?? slugify(source.split("/").pop() ?? "image")}`;
        const files = input.save === false ? [] : await saveSvgs(response, outDir, stem);
        return summarize(response, model, files);
      }),
  );

  return server;
}
