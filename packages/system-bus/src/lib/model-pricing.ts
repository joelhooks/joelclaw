import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type ModelRate = {
  model: string;
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  source: "openrouter";
  fetchedAt: number;
};

export type CostEstimate = {
  costTotal: number;
  source: "provider" | "openrouter-benchmark";
  rate?: ModelRate;
};

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type ModelPricingOptions = {
  fetchImpl?: FetchLike;
  cachePath?: string;
  ttlMs?: number;
  url?: string;
};

type PricingEntry = {
  id: string;
  promptUsdPerToken: number;
  completionUsdPerToken: number;
};

type PricingSnapshot = {
  fetchedAt: number;
  models: PricingEntry[];
};

const DEFAULT_PRICING_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TTL_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 10_000;

const snapshotMemo = new Map<string, PricingSnapshot>();

function defaultCachePath(): string {
  return path.join(os.homedir(), ".joelclaw", "cache", "openrouter-pricing.json");
}

function resolveCachePath(options?: ModelPricingOptions): string {
  return options?.cachePath ?? process.env.JOELCLAW_PRICING_CACHE_PATH ?? defaultCachePath();
}

function resolveTtlMs(options?: ModelPricingOptions): number {
  if (typeof options?.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0) {
    return options.ttlMs;
  }
  const fromEnv = Number(process.env.JOELCLAW_PRICING_TTL_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TTL_MS;
}

function resolveUrl(options?: ModelPricingOptions): string {
  return options?.url ?? process.env.JOELCLAW_PRICING_URL ?? DEFAULT_PRICING_URL;
}

function splitModelId(model: string): { provider: string | null; name: string } {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { provider: null, name: trimmed };
  return { provider: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

function normalizeName(name: string): string {
  return name.replaceAll(".", "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseUsdPerToken(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePricingEntry(raw: unknown): PricingEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (!isRecord(raw.pricing)) return null;
  const promptUsdPerToken = parseUsdPerToken(raw.pricing.prompt);
  const completionUsdPerToken = parseUsdPerToken(raw.pricing.completion);
  if (promptUsdPerToken === null || completionUsdPerToken === null) return null;
  return { id: raw.id, promptUsdPerToken, completionUsdPerToken };
}

function parsePricingResponse(raw: unknown, fetchedAt: number): PricingSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return null;
  const models: PricingEntry[] = [];
  for (const item of raw.data) {
    const entry = parsePricingEntry(item);
    if (entry) models.push(entry);
  }
  return { fetchedAt, models };
}

function parseSnapshotFile(raw: unknown): PricingSnapshot | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.fetchedAt !== "number" || !Number.isFinite(raw.fetchedAt)) return null;
  if (!Array.isArray(raw.models)) return null;
  const models: PricingEntry[] = [];
  for (const item of raw.models) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (typeof item.promptUsdPerToken !== "number" || !Number.isFinite(item.promptUsdPerToken)) {
      continue;
    }
    if (
      typeof item.completionUsdPerToken !== "number" ||
      !Number.isFinite(item.completionUsdPerToken)
    ) {
      continue;
    }
    models.push({
      id: item.id,
      promptUsdPerToken: item.promptUsdPerToken,
      completionUsdPerToken: item.completionUsdPerToken,
    });
  }
  return { fetchedAt: raw.fetchedAt, models };
}

async function readSnapshotFile(cachePath: string): Promise<PricingSnapshot | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    return parseSnapshotFile(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function writeSnapshotFile(cachePath: string, snapshot: PricingSnapshot): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(snapshot), "utf8");
}

async function fetchSnapshot(url: string, fetchImpl: FetchLike): Promise<PricingSnapshot | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return parsePricingResponse(body, Date.now());
  } catch {
    return null;
  }
}

async function loadSnapshot(options?: ModelPricingOptions): Promise<PricingSnapshot | null> {
  const cachePath = resolveCachePath(options);
  const ttlMs = resolveTtlMs(options);
  const now = Date.now();

  const memo = snapshotMemo.get(cachePath);
  if (memo && now - memo.fetchedAt < ttlMs) return memo;

  const fromFile = await readSnapshotFile(cachePath);
  if (fromFile && now - fromFile.fetchedAt < ttlMs) {
    snapshotMemo.set(cachePath, fromFile);
    return fromFile;
  }

  const fetched = await fetchSnapshot(resolveUrl(options), options?.fetchImpl ?? fetch);
  if (fetched) {
    snapshotMemo.set(cachePath, fetched);
    await writeSnapshotFile(cachePath, fetched).catch(() => {});
    return fetched;
  }

  const stale = fromFile ?? memo ?? null;
  if (stale) snapshotMemo.set(cachePath, stale);
  return stale;
}

export async function getModelRate(
  model: string,
  options?: ModelPricingOptions,
): Promise<ModelRate | null> {
  try {
    const target = splitModelId(model);
    if (!target.name) return null;

    const snapshot = await loadSnapshot(options);
    if (!snapshot) return null;

    const targetName = normalizeName(target.name);
    const matches = snapshot.models.filter(
      (entry) => normalizeName(splitModelId(entry.id).name) === targetName,
    );
    if (matches.length === 0) return null;

    const byProvider = target.provider
      ? matches.find((entry) => splitModelId(entry.id).provider === target.provider)
      : undefined;
    const match = byProvider ?? matches[0];
    if (!match) return null;

    return {
      model: match.id,
      promptUsdPerToken: match.promptUsdPerToken,
      completionUsdPerToken: match.completionUsdPerToken,
      source: "openrouter",
      fetchedAt: snapshot.fetchedAt,
    };
  } catch {
    return null;
  }
}

export function estimateCost(
  usage: { inputTokens?: number; outputTokens?: number; costTotal?: number },
  rate: ModelRate | null,
): CostEstimate | null {
  if (
    typeof usage.costTotal === "number" &&
    Number.isFinite(usage.costTotal) &&
    usage.costTotal > 0
  ) {
    return { costTotal: usage.costTotal, source: "provider" };
  }

  if (!rate) return null;

  const inputTokens =
    typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)
      ? usage.inputTokens
      : null;
  const outputTokens =
    typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)
      ? usage.outputTokens
      : null;
  if (inputTokens === null && outputTokens === null) return null;
  const costTotal =
    (inputTokens ?? 0) * rate.promptUsdPerToken + (outputTokens ?? 0) * rate.completionUsdPerToken;

  return { costTotal, source: "openrouter-benchmark", rate };
}

export const __testables = {
  resetPricingMemo: (): void => {
    snapshotMemo.clear();
  },
  normalizeName,
  splitModelId,
};
