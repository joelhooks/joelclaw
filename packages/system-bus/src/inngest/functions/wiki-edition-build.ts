import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { notifyAgent } from "../../lib/notify-agent";
import { notifyJoel, redactJoelMessage } from "../../lib/notify-joel";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const execFile = promisify(execFileCallback);

const WIKI_CWD =
  process.env.JOELCLAW_WIKI_CWD ?? join(homedir(), "Code", "joelhooks", "joelclaw-wiki");
const COMMAND_TIMEOUT_MS = 600_000;

type JsonRecord = Record<string, unknown>;

type SourceRun = {
  status?: string;
  [key: string]: unknown;
};

type BuildEditionSuccess = {
  ok: true;
  result: JsonRecord;
  state: unknown;
  editionId: string | null;
  written: unknown;
  loopCount: unknown;
  observationCount: unknown;
  sourceRuns: SourceRun[];
};

type BuildStepResult =
  | BuildEditionSuccess
  | {
      ok: false;
      phase: "build-edition" | "build-static";
      error: string;
      state?: string;
      sourceRuns?: SourceRun[];
    };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSourceRuns(value: unknown): SourceRun[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry) => ({ ...entry }));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function pickField(result: JsonRecord, state: unknown, key: string): unknown {
  if (result[key] !== undefined) return result[key];
  if (isRecord(state)) return state[key];
  return undefined;
}

function parseEditionBuild(stdout: string): BuildEditionSuccess {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("wiki edition build returned non-object JSON");
  }

  const state = parsed.state ?? parsed;
  const sourceRuns = asSourceRuns(pickField(parsed, state, "sourceRuns"));

  return {
    ok: true,
    result: parsed,
    state,
    editionId:
      stringValue(pickField(parsed, state, "editionId")) ??
      stringValue(pickField(parsed, state, "id")),
    written: pickField(parsed, state, "written"),
    loopCount: pickField(parsed, state, "loopCount"),
    observationCount: pickField(parsed, state, "observationCount"),
    sourceRuns,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "wiki edition build returned invalid JSON";
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "unknown error";
}

function failedEditionResult(parsed: BuildEditionSuccess): BuildStepResult {
  const state = typeof parsed.state === "string" ? parsed.state : "unknown";
  return {
    ok: false,
    phase: "build-edition",
    state,
    error: redactJoelMessage(`${state}: ${stringValue(parsed.result.error) ?? "no error text"}`),
    sourceRuns: parsed.sourceRuns
      .filter((run) => run.status === "failed" || run.status === "blocked")
      .map((run) => ({ status: run.status, kind: stringValue(run.kind) ?? "unknown" })),
  };
}

function buildEditionFailure(error: unknown): BuildStepResult {
  const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : null;
  if (stdout !== null) {
    try {
      const parsed = parseEditionBuild(stdout);
      return parsed.state === "exists" ? parsed : failedEditionResult(parsed);
    } catch {
      // Invalid stdout is not a successful build.
    }
  }
  return { ok: false, phase: "build-edition", error: redactJoelMessage(errorMessage(error)) };
}

function buildStaticFailure(error: unknown): BuildStepResult {
  const stderr =
    isRecord(error) && typeof error.stderr === "string" ? error.stderr.slice(-600) : "";
  return {
    ok: false,
    phase: "build-static",
    error: redactJoelMessage(
      [errorMessage(error).slice(0, 300), stderr].filter(Boolean).join("\n"),
    ),
  };
}

function blockedSourceRuns(sourceRuns: SourceRun[]): SourceRun[] {
  return sourceRuns.filter((entry) => entry.status === "blocked");
}

function buildNotification(input: {
  buildEdition: BuildStepResult;
  buildStatic?: BuildStepResult;
  blockedCount: number;
}): string {
  const failures = [input.buildEdition, input.buildStatic]
    .filter((result): result is Extract<BuildStepResult, { ok: false }> => result?.ok === false)
    .map((result) => `${result.phase}: ${result.error}`);
  const failedRuns = (input.buildEdition.sourceRuns ?? []).filter(
    (run) => run.status === "failed" || run.status === "blocked",
  );
  const sourceKinds = failedRuns.map((run) => `${run.status}: ${String(run.kind)}`);

  return [
    "wiki edition build receipt",
    failures.length > 0 ? `failed: ${failures.join(", ")}` : "build: ok",
    input.blockedCount > 0
      ? `blocked source runs: ${input.blockedCount}`
      : "blocked source runs: 0",
    ...(sourceKinds.length > 0 ? [`source run kinds: ${sourceKinds.join(", ")}`] : []),
  ].join("\n");
}

export const __wikiEditionBuildTestUtils = {
  parseEditionBuild,
  blockedSourceRuns,
  buildNotification,
  buildEditionFailure,
  buildStaticFailure,
};

export const wikiEditionBuild = inngest.createFunction(
  {
    id: "wiki-edition-build",
    name: "Wiki Edition Build",
    retries: 1,
    concurrency: { limit: 1 },
  },
  [{ cron: "TZ=America/Los_Angeles 0 6 * * *" }, { event: "wiki/edition.build.requested" }],
  async ({ step }) => {
    const buildEdition = await step.run("build-edition", async (): Promise<BuildStepResult> => {
      try {
        const { stdout } = await execFile(
          "bun",
          ["run", "src/cli/wiki.ts", "edition", "build", "--gmail", "--json"],
          { cwd: WIKI_CWD, timeout: COMMAND_TIMEOUT_MS },
        );
        const parsed = parseEditionBuild(stdout);
        // the machine can terminate in failed/cancelled WITHOUT the process
        // crashing — a parseable JSON payload is not success; the state is.
        if (parsed.state === "failed" || parsed.state === "cancelled") {
          return failedEditionResult(parsed);
        }
        return parsed;
      } catch (error) {
        return buildEditionFailure(error);
      }
    });

    const buildStatic = buildEdition.ok
      ? await step.run("build-static", async (): Promise<BuildStepResult> => {
          try {
            await execFile("bun", ["run", "build"], { cwd: WIKI_CWD, timeout: COMMAND_TIMEOUT_MS });
            return buildEdition;
          } catch (error) {
            return buildStaticFailure(error);
          }
        })
      : undefined;

    const sourceRuns = buildEdition.sourceRuns ?? [];
    const blockedRuns = blockedSourceRuns(sourceRuns);
    const failed = !buildEdition.ok || buildStatic?.ok === false;

    await step.run("emit-wiki-edition-build-otel", async () => {
      await emitOtelEvent({
        level: failed || blockedRuns.length > 0 ? "warn" : "info",
        source: "worker",
        component: "wiki-edition-build",
        action: "wiki.edition.build",
        success: !failed,
        error: failed
          ? [buildEdition, buildStatic]
              .filter(
                (result): result is Extract<BuildStepResult, { ok: false }> => result?.ok === false,
              )
              .map((result) => `${result.phase}: ${result.error}`)
              .join("; ")
          : undefined,
        metadata: {
          editionId: buildEdition.ok ? buildEdition.editionId : null,
          buildState: typeof buildEdition.state === "string" ? buildEdition.state : undefined,
          failedSourceRunKinds: sourceRuns
            .filter((run) => run.status === "failed" || run.status === "blocked")
            .map((run) => ({ status: run.status, kind: stringValue(run.kind) ?? "unknown" })),
          staticError: buildStatic?.ok === false ? buildStatic.error : undefined,
          blockedSourceRunCount: blockedRuns.length,
          sourceRunCount: sourceRuns.length,
          staticBuilt: buildStatic?.ok === true,
        },
      });
    });

    if (buildEdition.ok && buildStatic?.ok === true) {
      await step.sendEvent("wiki-edition-built", {
        name: "wiki/edition.built",
        data: {
          editionId: buildEdition.editionId,
          state: buildEdition.state,
          written: buildEdition.written,
          loopCount: buildEdition.loopCount,
          observationCount: buildEdition.observationCount,
          sourceRuns: buildEdition.sourceRuns,
        },
      });

      // the bugle IS the Daily SHITRAT: deliver the morning receipt — lead
      // headline + loop counts + the tailnet-only URL — on every good build
      const receipt = await step.run("compose-morning-receipt", async () => {
        try {
          const raw = await readFile(
            `${WIKI_CWD}/data/editions/${buildEdition.editionId}.json`,
            "utf8",
          );
          const edition = JSON.parse(raw) as {
            lead?: { headline?: string };
            loops?: { needsJoel?: boolean }[];
          };
          const headline = edition.lead?.headline ?? "(no lead)";
          const loops = edition.loops ?? [];
          const needsJoel = loops.filter((l) => l.needsJoel === true).length;
          return `🗞 ${buildEdition.editionId} — ${headline}\n${loops.length} open loops · ${needsJoel} need you · https://brain.joelclaw.com`;
        } catch {
          return `🗞 ${buildEdition.editionId} — edition built · https://brain.joelclaw.com`;
        }
      });
      await step.run("notify-morning-receipt", () =>
        notifyAgent({
          to: "switchboard/ea",
          source: "wiki-edition-build",
          summary: "Wiki edition built",
          message: receipt,
        }),
      );
    }

    if (failed || blockedRuns.length > 0) {
      await step.run("notify-wiki-edition-build-receipt", () =>
        notifyJoel({
          kind: "needs_joel",
          source: "wiki-edition-build",
          message: buildNotification({
            buildEdition,
            buildStatic,
            blockedCount: blockedRuns.length,
          }),
        }),
      );
    }

    if (!buildEdition.ok) throw new Error(buildEdition.error);
    if (buildStatic?.ok === false) throw new Error(buildStatic.error);

    return {
      status: blockedRuns.length > 0 ? "blocked" : "built",
      editionId: buildEdition.editionId,
      blockedSourceRunCount: blockedRuns.length,
      sourceRunCount: sourceRuns.length,
    };
  },
);
