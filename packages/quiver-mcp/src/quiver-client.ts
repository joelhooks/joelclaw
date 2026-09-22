// Thin fetch client for the QuiverAI REST API (https://docs.quiver.ai/api-reference).
// Only the three operations the MCP exposes: list models, text to SVG, image to SVG.
// Field names are mapped from the API's snake_case to camelCase at this boundary.

export const DEFAULT_BASE_URL = "https://api.quiver.ai";
export const DEFAULT_TIMEOUT_MS = 180_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface QuiverErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly requestId?: string;
  readonly retryAfter?: number;
  readonly param?: string;
}

export class QuiverError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;
  readonly param: string | undefined;

  constructor(envelope: QuiverErrorEnvelope) {
    super(envelope.message);
    this.name = "QuiverError";
    this.code = envelope.code;
    this.status = envelope.status;
    this.requestId = envelope.requestId;
    this.retryAfter = envelope.retryAfter;
    this.param = envelope.param;
  }

  toJSON(): QuiverErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.retryAfter === undefined ? {} : { retryAfter: this.retryAfter }),
      ...(this.param === undefined ? {} : { param: this.param }),
    };
  }
}

export interface SvgDocument {
  readonly mimeType: string;
  readonly svg: string;
}

export interface SvgResponse {
  readonly id: string;
  readonly created: number;
  readonly credits: number | undefined;
  readonly usage: Record<string, unknown> | undefined;
  readonly data: readonly SvgDocument[];
}

export interface QuiverModel {
  readonly id: string;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly supportedOperations: readonly string[];
  readonly pricingCredits: Record<string, number>;
}

export interface GenerateRequest {
  readonly prompt: string;
  readonly model: string;
  readonly instructions?: string;
  readonly n?: number;
  readonly reasoningEffort?: ReasoningEffort;
  /** Reference image URLs. Model-specific limit; 4 for Arrow 1.x. */
  readonly references?: readonly string[];
}

export type ImageInput = { readonly url: string } | { readonly base64: string };

export interface VectorizeRequest {
  readonly model: string;
  readonly image: ImageInput;
  readonly autoCrop?: boolean;
  readonly targetSize?: number;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface QuiverClient {
  listModels(signal?: AbortSignal): Promise<QuiverModel[]>;
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<SvgResponse>;
  vectorize(request: VectorizeRequest, signal?: AbortSignal): Promise<SvgResponse>;
}

export interface QuiverClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

function parseEnvelope(status: number, body: unknown): QuiverError {
  const source = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {};
  const requestId = str(source.request_id ?? source.requestId);
  const retryAfter = num(source.retry_after ?? source.retryAfter);
  const param = str(source.param);
  return new QuiverError({
    code: str(source.code) ?? `http_${status}`,
    message: str(source.message) ?? `Quiver request failed with HTTP ${status}`,
    status: num(source.status) ?? status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(param === undefined ? {} : { param }),
  });
}

function parseSvgResponse(body: unknown): SvgResponse {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new QuiverError({ code: "invalid_response", message: "Quiver returned no SVG data array", status: 502 });
  }
  const data: SvgDocument[] = [];
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.svg !== "string") {
      throw new QuiverError({ code: "invalid_response", message: "Quiver returned a document without svg markup", status: 502 });
    }
    data.push({ mimeType: str(item.mime_type ?? item.mimeType) ?? "image/svg+xml", svg: item.svg });
  }
  return {
    id: str(body.id) ?? "",
    created: num(body.created) ?? 0,
    credits: num(body.credits),
    usage: isRecord(body.usage) ? body.usage : undefined,
    data,
  };
}

function parseModels(body: unknown): QuiverModel[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new QuiverError({ code: "invalid_response", message: "Quiver returned no models array", status: 502 });
  }
  const models: QuiverModel[] = [];
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const credits: Record<string, number> = {};
    const pricing = item.pricing_credits ?? item.pricingCredits;
    if (isRecord(pricing)) {
      for (const [key, value] of Object.entries(pricing)) {
        if (typeof value === "number") credits[key] = value;
      }
    }
    const operations = item.supported_operations ?? item.supportedOperations;
    models.push({
      id: item.id,
      name: str(item.name),
      description: str(item.description),
      supportedOperations: Array.isArray(operations)
        ? operations.filter((operation): operation is string => typeof operation === "string")
        : [],
      pricingCredits: credits,
    });
  }
  return models;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function createQuiverClient(options: QuiverClientOptions): QuiverClient {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") throw new Error("Quiver API key is empty");
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: withTimeout(signal, timeoutMs),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new QuiverError({ code: "invalid_response", message: "Quiver returned non-JSON output", status: 502 });
        }
      }
    }
    if (!response.ok) throw parseEnvelope(response.status, body);
    return body;
  }

  return {
    async listModels(signal) {
      return parseModels(await request("/v1/models", { method: "GET" }, signal));
    },
    async generate(req, signal) {
      const body = {
        model: req.model,
        prompt: req.prompt,
        n: req.n ?? 1,
        stream: false,
        ...(req.instructions === undefined ? {} : { instructions: req.instructions }),
        ...(req.reasoningEffort === undefined ? {} : { reasoning_effort: req.reasoningEffort }),
        ...(req.references === undefined || req.references.length === 0
          ? {}
          : { references: req.references.map((url) => ({ url })) }),
      };
      return parseSvgResponse(await request("/v1/svgs/generations", { method: "POST", body }, signal));
    },
    async vectorize(req, signal) {
      const body = {
        model: req.model,
        image: req.image,
        stream: false,
        auto_crop: req.autoCrop ?? false,
        ...(req.targetSize === undefined ? {} : { target_size: req.targetSize }),
        ...(req.reasoningEffort === undefined ? {} : { reasoning_effort: req.reasoningEffort }),
      };
      return parseSvgResponse(await request("/v1/svgs/vectorizations", { method: "POST", body }, signal));
    },
  };
}
