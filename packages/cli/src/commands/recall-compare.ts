/**
 * `joelclaw recall-compare` — offline recall comparison.
 *
 * Requires an exact scope and an explicit access decision. Calls the CLI
 * SQLite-first adapter, the SDK in-process Typesense adapter, and the registered
 * composed adapter, then writes one private receipt. It changes no binding and
 * mutates no store.
 *
 * The question is read from a file or stdin, never from argv. A query on a
 * command line lands in shell history, in `ps` output, and in any process
 * listing on the machine.
 *
 * Exit codes: 0 complete, 1 invalid input or unwritable receipt, 3 receipt
 * written but the comparison was incomplete.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command, Options } from "@effect/cli";
import { Console, Effect, Schema } from "effect";
import {
  CASE_ID_PATTERN,
  comparisonIsComplete,
  isValidCaseId,
  runRecallComparison,
  writeRecallComparisonReceipt,
} from "../recall/comparison";
import { COMPOSED_RECALL_SCHEMA_VERSION, ComposedRecallRequestV1Schema } from "../recall/contract";
import { respond, respondError } from "../response";

const queryFile = Options.text("query-file");
const caseId = Options.text("case-id").pipe(Options.optional);
const project = Options.text("project");
const workstream = Options.text("workstream");
const principalRef = Options.text("principal-ref");
const purpose = Options.text("purpose");
const decidedAt = Options.text("decided-at");
const allowedPrivacy = Options.text("allowed-privacy").pipe(Options.withDefault("private"));
const includeSuperseded = Options.boolean("include-superseded").pipe(Options.withDefault(false));
const reflectionLimit = Options.integer("reflection-limit").pipe(Options.withDefault(5));
const observationLimit = Options.integer("observation-limit").pipe(Options.withDefault(5));
const curatedLimit = Options.integer("curated-limit").pipe(Options.withDefault(5));
const out = Options.text("out").pipe(Options.optional);

const decodeRequest = Schema.decodeUnknownEither(ComposedRecallRequestV1Schema);

/** `-` reads stdin. Anything else is a path. The text never touches argv. */
export async function readQueryText(source: string): Promise<string> {
  // File descriptor 0 is stdin. `readFileSync` is the API that accepts a raw
  // descriptor; the promise API wants a handle.
  const raw = source === "-" ? readFileSync(0, "utf8") : await readFile(source, "utf8");
  return raw.replace(/\r?\n$/u, "");
}

/**
 * POSIX single-quoting. A receipt path can be anything `--out` accepted, and a
 * next action is copy-pasted into a shell, so it is quoted rather than
 * interpolated. Nothing inside single quotes is expanded except a single quote
 * itself, which is closed, escaped, and reopened.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function defaultReceiptPath(now: Date): string {
  const stamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  return join(homedir(), ".joelclaw", "receipts", "recall-comparison", `${stamp}.json`);
}

export const recallCompareCmd = Command.make(
  "recall-compare",
  {
    queryFile,
    caseId,
    project,
    workstream,
    principalRef,
    purpose,
    decidedAt,
    allowedPrivacy,
    includeSuperseded,
    reflectionLimit,
    observationLimit,
    curatedLimit,
    out,
  },
  (options) =>
    Effect.gen(function* () {
      const now = new Date();

      const text = yield* Effect.tryPromise({
        try: () => readQueryText(options.queryFile),
        catch: () => "unreadable" as const,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (text === null) {
        process.exitCode = 1;
        yield* Console.log(
          respondError(
            "recall-compare",
            "The comparison question could not be read",
            "RECALL_COMPARE_QUERY_UNREADABLE",
            "Pass --query-file - to read the question from stdin, or --query-file <path> to read it from a private file.",
            [
              {
                command: "joelclaw recall-compare --help",
                description: "Show every required scope and access flag",
              },
            ],
          ),
        );
        return;
      }

      if (options.caseId._tag === "Some" && !isValidCaseId(options.caseId.value.trim())) {
        process.exitCode = 1;
        yield* Console.log(
          respondError(
            "recall-compare",
            "The case ID must be a short opaque label, not a question or a path",
            "RECALL_COMPARE_INVALID_CASE_ID",
            `Pass --case-id matching ${CASE_ID_PATTERN.source}, for example --case-id recall-2026-08-22-a. The label is hashed into the receipt, never stored.`,
            [
              {
                command: "joelclaw recall-compare --help",
                description: "Show every required scope and access flag",
              },
            ],
          ),
        );
        return;
      }

      const request = decodeRequest({
        _tag: "ComposedRecallRequestV1",
        access: {
          _tag: "RecallAccessV1",
          allowedPrivacy: options.allowedPrivacy
            .split(",")
            .map((tier) => tier.trim())
            .filter(Boolean),
          decidedAt: options.decidedAt,
          principalRef: options.principalRef,
          purpose: options.purpose,
        },
        includeSuperseded: options.includeSuperseded,
        limits: {
          curated: options.curatedLimit,
          observations: options.observationLimit,
          reflections: options.reflectionLimit,
        },
        schemaVersion: COMPOSED_RECALL_SCHEMA_VERSION,
        scope: {
          _tag: "ProjectWorkstream",
          project: options.project,
          workstream: options.workstream,
        },
        text,
      });

      if (request._tag === "Left") {
        process.exitCode = 1;
        yield* Console.log(
          respondError(
            "recall-compare",
            "Composed recall comparison requires an exact scope, an explicit access decision, and a question of 1 to 1000 characters",
            "RECALL_COMPARE_INVALID_REQUEST",
            "Pass --project, --workstream, --principal-ref, --purpose, --decided-at (ISO-8601), --allowed-privacy, and --query-file.",
            [
              {
                command: "joelclaw recall-compare --help",
                description: "Show every required scope and access flag",
              },
            ],
          ),
        );
        return;
      }

      const receipt = yield* Effect.promise(() =>
        runRecallComparison({
          request: request.right,
          now,
          ...(options.caseId._tag === "Some" ? { caseId: options.caseId.value } : {}),
        }),
      );

      const path = options.out._tag === "Some" ? options.out.value : defaultReceiptPath(now);
      const written = yield* Effect.tryPromise({
        try: () => writeRecallComparisonReceipt(path, receipt),
        catch: () => "unwritable" as const,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (written === null) {
        process.exitCode = 1;
        yield* Console.log(
          respondError(
            "recall-compare",
            "The comparison receipt could not be written",
            "RECALL_COMPARE_RECEIPT_NOT_WRITTEN",
            "Receipts are create-exclusive. Choose a path that does not exist yet with --out.",
            [
              {
                command: "joelclaw recall-compare --help",
                description: "Show every required scope and access flag",
              },
            ],
          ),
        );
        return;
      }

      // The receipt is written before the exit code is set. An incomplete run
      // still leaves its partial lane data on disk to be read.
      const complete = comparisonIsComplete(receipt);
      if (!complete) process.exitCode = 3;

      yield* Console.log(
        respond(
          "recall-compare",
          {
            receiptPath: path,
            schemaVersion: receipt.schemaVersion,
            caseId: receipt.caseId,
            complete,
            scope: receipt.request.scope,
            contractCorrect: receipt.contractCorrect,
            useful: receipt.useful,
            old: receipt.old.map((entry) => ({
              caller: entry.caller,
              adapter: entry.adapter,
              ok: entry.ok,
              backendKind: entry.backendKind,
              durationMs: entry.durationMs,
              hitCount: entry.hits.length,
              outOfScopeHitCount: entry.outOfScopeHitCount,
              duplicateIdCount: entry.duplicateIdCount,
              ...(entry.failureCode ? { failureCode: entry.failureCode } : {}),
            })),
            composed: {
              ok: receipt.composed.ok,
              adapter: receipt.composed.adapter,
              unavailableLanes: receipt.composed.unavailableLanes,
              ...(receipt.composed.failureCode
                ? { failureCode: receipt.composed.failureCode }
                : {}),
              lanes: receipt.composed.lanes.map((lane) => ({
                lane: lane.lane,
                available: lane.available,
                itemCount: lane.items.length,
                itemsMissingEvidence: lane.itemsMissingEvidence,
                ...(lane.health ? { health: lane.health } : {}),
                ...(lane.unavailableCode ? { unavailableCode: lane.unavailableCode } : {}),
              })),
            },
            overlap: receipt.overlap,
          },
          [
            {
              command: `jq '.contractCorrect, .useful' ${shellQuote(path)}`,
              description: "Read the two verdicts without reading the whole receipt",
            },
            {
              command: "joelclaw capabilities",
              description: "Confirm the production recall binding is unchanged",
            },
          ],
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Compare the CLI, SDK, and composed recall paths for one exact scope; reads the question from --query-file and writes a private 0600 receipt",
  ),
);
