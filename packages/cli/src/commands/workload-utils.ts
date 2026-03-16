import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

import {
  LOCAL_SANDBOX_STATES,
  type EnumParseResult,
  type LocalSandboxState,
  type OptionalText,
  type PathScopeSeed,
  type PathsFromDirective,
} from "./workload-types";

export const lower = (value: string) => value.toLowerCase();

export const dedupe = <T extends string>(values: readonly T[]): T[] => [
  ...new Set(values),
];

export const shellQuote = (value: string) => JSON.stringify(value);

export const splitCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

export const splitDelimited = (value: string | undefined): string[] => {
  if (!value) return [];
  const separator = value.includes("|") ? "|" : ",";
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
};

export const splitLines = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
};

export const trimClause = (value: string) =>
  value
    .trim()
    .replace(/^[\s;,.:-]+/u, "")
    .replace(/[\s;,.:-]+$/u, "");

export const splitClauses = (value: string): string[] => {
  const source = value.trim();
  if (source.length === 0) return [];

  if (source.includes(";")) {
    return source.split(/;+/u).map(trimClause).filter(Boolean);
  }

  const lineClauses = splitLines(source).map(trimClause).filter(Boolean);
  if (lineClauses.length > 1) {
    return lineClauses;
  }

  return source.split(/\.\s+/u).map(trimClause).filter(Boolean);
};

export const extractIntentSection = (
  intent: string,
  label: string,
  stopMarkers: readonly string[],
): string | undefined => {
  const lowered = lower(intent);
  const labelNeedle = `${lower(label)}:`;
  const start = lowered.indexOf(labelNeedle);
  if (start === -1) return undefined;

  const contentStart = start + labelNeedle.length;
  let end = intent.length;

  for (const marker of stopMarkers) {
    const index = lowered.indexOf(lower(marker), contentStart);
    if (index !== -1 && index < end) {
      end = index;
    }
  }

  const section = intent.slice(contentStart, end).trim();
  return section.length > 0 ? section : undefined;
};

export const extractAcceptanceFromIntent = (intent: string): string[] => {
  const section = extractIntentSection(intent, "acceptance", [
    " goal:",
    " context:",
    " constraints:",
    " if these changes",
    " if this changes",
    " stop and",
  ]);

  return section ? splitClauses(section) : [];
};

export const extractGoalMilestones = (intent: string): string[] => {
  const section =
    extractIntentSection(intent, "goal", [
      " acceptance:",
      " context:",
      " constraints:",
      " if these changes",
      " if this changes",
      " stop and",
    ]) ?? intent;

  return splitClauses(section).filter(
    (clause) => !/^acceptance\b/iu.test(clause),
  );
};

export const shouldInsertReflectionStage = (
  intent: string,
  acceptance: readonly string[],
): boolean => {
  const combined = lower([intent, ...acceptance].join(" "));
  return hasAny(combined, [
    "reflect",
    "reflection",
    "plan-update",
    "update plan",
    "re-plan",
    "replan",
    "update the plan",
  ]);
};

export const toStageName = (value: string, fallback: string): string => {
  const clause = trimClause(value);
  if (clause.length === 0) return fallback;
  if (clause.length <= 88) return clause;
  return `${clause.slice(0, 85).trimEnd()}…`;
};

export const parseEnumList = <T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): EnumParseResult<T> => {
  const values = splitCsv(raw);
  const allowedSet = new Set(allowed);
  const known: T[] = [];
  const unknown: string[] = [];

  for (const value of values) {
    if (allowedSet.has(value as T)) {
      known.push(value as T);
    } else {
      unknown.push(value);
    }
  }

  return { values: dedupe(known), unknown: dedupe(unknown) };
};

export const hasAny = (value: string, needles: readonly string[]) =>
  needles.some((needle) => value.includes(needle));

export const hasExplicitIsolationIntent = (value: string) =>
  hasAny(value, [
    "sandbox required",
    "require sandbox",
    "run in sandbox",
    "use a sandbox",
    "sandbox this",
    "isolated execution",
    "isolation required",
    "inside sandbox",
    "sandboxed execution",
  ]);

export const hasExplicitDeployIntent = (value: string) =>
  hasAny(value, [
    "deploy",
    "release this",
    "cut release",
    "publish this",
    "publish package",
    "publish packages",
    "ship to prod",
    "ship to production",
  ]);

export const expandHome = (value: string) =>
  value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value;

export const runGitRaw = (repoPath: string, args: string[]): string | undefined => {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout;
};

export const runGit = (repoPath: string, args: string[]): string | undefined => {
  const output = runGitRaw(repoPath, args)?.trim();
  return output && output.length > 0 ? output : undefined;
};

export const normalizeGitPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.includes(" -> ")) return trimmed;
  return trimmed.split(" -> ").at(-1)?.trim() ?? trimmed;
};

export const parsePathsFrom = (
  value: string | undefined,
): PathsFromDirective | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const lowered = lower(trimmed);

  if (lowered === "status") {
    return { raw: trimmed, source: "status" };
  }

  if (lowered === "head") {
    return { raw: trimmed, source: "head" };
  }

  const recentMatch = lowered.match(/^recent:(\d+)$/u);
  if (recentMatch) {
    const count = Number.parseInt(recentMatch[1] ?? "0", 10);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`Invalid --paths-from value: ${trimmed}`);
    }
    return { raw: trimmed, source: "recent", count };
  }

  throw new Error(
    `Invalid --paths-from value: ${trimmed}. Use status, head, or recent:<n>`,
  );
};

export const collectGitStatusPaths = (repoPath: string): string[] => {
  const output = runGitRaw(repoPath, [
    "status",
    "--short",
    "--untracked-files=all",
    "--porcelain=v1",
  ]);

  return dedupe(
    splitLines(output)
      .map((line) => normalizeGitPath(line.slice(3)))
      .filter(Boolean),
  ).sort((left, right) => left.localeCompare(right));
};

export const collectGitNamedPaths = (repoPath: string, args: string[]): string[] =>
  dedupe(
    splitLines(runGitRaw(repoPath, args))
      .map((line) => normalizeGitPath(line))
      .filter(Boolean),
  ).sort((left, right) => left.localeCompare(right));

export const collectPathsFromDirective = (
  repoPath: string,
  directive: PathsFromDirective,
): { paths: string[]; scope: PathScopeSeed } => {
  switch (directive.source) {
    case "status": {
      const paths = collectGitStatusPaths(repoPath);
      return {
        paths,
        scope: {
          source: "git-status",
          detail: directive.raw,
          pathCount: paths.length,
        },
      };
    }
    case "head": {
      const paths = collectGitNamedPaths(repoPath, [
        "show",
        "--pretty=format:",
        "--name-only",
        "HEAD",
      ]);
      return {
        paths,
        scope: {
          source: "git-head",
          detail: directive.raw,
          pathCount: paths.length,
        },
      };
    }
    case "recent": {
      const paths = collectGitNamedPaths(repoPath, [
        "log",
        `-n${directive.count}`,
        "--name-only",
        "--pretty=format:",
      ]);
      return {
        paths,
        scope: {
          source: "git-recent",
          detail: directive.raw,
          pathCount: paths.length,
        },
      };
    }
  }
};

export function isLocalSandboxState(value: string): value is LocalSandboxState {
  return (LOCAL_SANDBOX_STATES as readonly string[]).includes(value);
}

export function normalizeOptionalFlagText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined;
  const normalized = value.value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function splitCsvValues(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
