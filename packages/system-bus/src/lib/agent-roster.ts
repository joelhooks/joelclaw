import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";

export type AgentDefinition = {
  name: string;
  description?: string;
  model: string;
  thinking?: string;
  tools: string[];
  skills: string[];
  extensions: string[];
  systemPrompt: string;
  source: "project" | "user" | "builtin";
  filePath: string;
};

const agentDefinitionCache = new Map<string, AgentDefinition | null>();

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function parseAgentDefinition(
  markdown: string,
  filePath: string,
  source: "project" | "user" | "builtin"
): AgentDefinition | null {
  try {
    const parsed = matter<Record<string, unknown>>(markdown);
    const name = normalizeText(parsed.data.name);
    const model = normalizeText(parsed.data.model);

    if (!name || !model) {
      return null;
    }

    return {
      name,
      description: normalizeText(parsed.data.description),
      model,
      thinking: normalizeText(parsed.data.thinking),
      tools: normalizeList(parsed.data.tools),
      skills: normalizeList(parsed.data.skills ?? parsed.data.skill),
      extensions: normalizeList(parsed.data.extensions ?? parsed.data.extension),
      systemPrompt: parsed.content.trim(),
      source,
      filePath,
    };
  } catch {
    return null;
  }
}

function buildCacheKey(name: string, cwd: string, home: string | undefined): string {
  return [name.toLowerCase(), cwd, home ?? ""].join("::");
}

export function clearAgentDefinitionCache(): void {
  agentDefinitionCache.clear();
}

export function loadAgentDefinition(name: string, cwd = process.cwd()): AgentDefinition | null {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return null;
  }

  const resolvedCwd = resolve(cwd);
  const homeDir = process.env.HOME ?? process.env.USERPROFILE;
  const cacheKey = buildCacheKey(normalizedName, resolvedCwd, homeDir);
  if (agentDefinitionCache.has(cacheKey)) {
    return agentDefinitionCache.get(cacheKey) ?? null;
  }

  const projectPath = join(resolvedCwd, ".pi", "agents", `${normalizedName}.md`);
  const builtinPath = join(resolvedCwd, "agents", `${normalizedName}.md`);
  const userPath = homeDir ? join(homeDir, ".pi", "agent", "agents", `${normalizedName}.md`) : null;

  const candidates: Array<{ path: string; source: "project" | "user" | "builtin" }> = [
    { path: projectPath, source: "project" },
    ...(userPath ? [{ path: userPath, source: "user" as const }] : []),
    { path: builtinPath, source: "builtin" },
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      continue;
    }

    try {
      const markdown = readFileSync(candidate.path, "utf-8");
      const definition = parseAgentDefinition(markdown, candidate.path, candidate.source);
      agentDefinitionCache.set(cacheKey, definition);
      return definition;
    } catch {
      agentDefinitionCache.set(cacheKey, null);
      return null;
    }
  }

  agentDefinitionCache.set(cacheKey, null);
  return null;
}
