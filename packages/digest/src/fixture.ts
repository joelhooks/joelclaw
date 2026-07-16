import {
  type ActionRegistryService,
  FIXTURE_SOURCE_REFS,
  type FixtureSourceAdapter,
  makeFixtureSourceAdapter,
} from "@joelclaw/source-actions";
import { Effect } from "effect";
import {
  type DigestService,
  type DigestServiceOptions,
  makeDigestService,
  makeFetchDigestLinkVerifier,
} from "./service";
import type { DigestError, DigestInput, DigestLinkVerifier, DigestResult } from "./types";

export type FixtureDigestPrototype = {
  adapter: FixtureSourceAdapter;
  service: DigestService;
  result: DigestResult;
};

export function createFixtureDigestInput(
  requestedAt = "2026-07-15T15:00:00.000Z",
): DigestInput {
  return {
    requestedAt,
    trigger: "on-demand",
    candidates: [
      {
        kind: "memory",
        quality: "high",
        relevance: 100,
        summary: "The Telegram signal system should protect attention, not mirror infrastructure logs.",
        source: "Telegram signal system working brief",
        happenedAt: "2026-07-15",
        whyNow: "The digest path is the first touchable proof of that contract.",
        connection: "This package is the seam between qualified signals and the agent loop.",
        sourceRef: FIXTURE_SOURCE_REFS.urlOnly,
      },
      {
        kind: "recovery-receipt",
        important: true,
        summary: "The fixture worker recovered without paging you.",
        whatBroke: "A synthetic health check failed once.",
        whatFixedIt: "The bounded recovery pass restarted the fixture worker.",
        proof: "Readback returned healthy on the next check.",
        remainingRisk: "None outside this fixture.",
      },
      {
        kind: "action",
        owner: "joel",
        title: "Touch Done and confirm the fixture mutation receipt.",
        sourceRef: FIXTURE_SOURCE_REFS.safeDone,
      },
      {
        kind: "reminder",
        owner: "joel",
        title: "Touch Dismiss and Snooze to prove interaction receipts.",
        sourceEvidence: "The digest prototype acceptance requires every control to be touched.",
        presentRelevance: "The controls are ready for the phone test now.",
        sourceRef: FIXTURE_SOURCE_REFS.snoozable,
      },
    ],
  };
}

export function buildFixtureDigestPrototype(
  actionRegistry: ActionRegistryService,
  options: {
    now?: () => Date;
    verifyLink?: DigestLinkVerifier;
    input?: DigestInput;
    actionTtlMs?: number;
    snoozeMs?: number;
  } = {},
): Effect.Effect<FixtureDigestPrototype, DigestError> {
  const adapter = makeFixtureSourceAdapter();
  const verifyLink: DigestLinkVerifier = options.verifyLink ?? makeFetchDigestLinkVerifier();
  const serviceOptions: DigestServiceOptions = {
    actionRegistry,
    adapters: { fixture: adapter },
    verifyLink,
    ...(options.now ? { now: options.now } : {}),
    ...(options.actionTtlMs ? { actionTtlMs: options.actionTtlMs } : {}),
    ...(options.snoozeMs ? { snoozeMs: options.snoozeMs } : {}),
  };
  const service = makeDigestService(serviceOptions);
  return service.assemble(options.input ?? createFixtureDigestInput()).pipe(
    Effect.map((result) => ({ adapter, service, result })),
  );
}
