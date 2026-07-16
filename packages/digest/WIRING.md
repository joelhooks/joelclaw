# Digest gateway wiring

`@joelclaw/digest` owns qualification, assembly, fixture controls, action execution, and receipt-gated control refresh. It does not import or intercept a channel.

## 1. Keep the natural-language path dumb

Normal text such as “give me the digest” already reaches the agent loop through `enqueueToGateway` in `packages/gateway/src/daemon.ts`. Register an agent tool around these exports:

- `DIGEST_AGENT_TOOL` — tool name, description, and input schema
- `runDigestAgentTool(service, input)` — assembly entry point
- `matchesNaturalLanguageDigestRequest(text)` — an intent test/hint only; **do not** call it from `telegram.ts`

The composition root must load real candidates, then call the service. `kind: "empty"` means send nothing.

## 2. Compose the service

Use the existing Redis client and source adapters:

```ts
import {
  buildFixtureDigestPrototype,
  makeFetchDigestLinkVerifier,
} from "@joelclaw/digest";
import { makeRedisActionRegistry } from "@joelclaw/source-actions";

const registry = makeRedisActionRegistry(redis);
const prototype = await Effect.runPromise(
  buildFixtureDigestPrototype(registry, {
    verifyLink: makeFetchDigestLinkVerifier(),
  }),
);
```

Keep `prototype.service` and `prototype.adapter` alive for the fixture callback test. The action registry is durable in Redis. The fixture adapter is intentionally process-local and must never be presented as production source durability.

## 3. Print before any real Telegram send

Hard gate for the phone prototype:

```ts
if (prototype.result.kind === "ready") {
  console.log("[digest:telegram-payload]", JSON.stringify(prototype.result.payload, null, 2));
  // Stop here for operator review before the first real send.
}
```

After Joel approves that exact printed payload, map it directly to the existing Telegram sender:

```ts
await sendTelegram(chatId, prototype.result.payload.text, {
  buttons: prototype.result.payload.buttons,
  outboundPolicy: prototype.result.payload.policy,
});
```

`signal/digest.assembled` currently needs an explicit **deliver** rule in the gateway outbound policy. Do not mislabel it as a reminder or use a specialized-UI exemption to sneak past policy.

## 4. Register the `act:` callback route

The current gateway callback handler does not recognize `act:`. Add one thin route in the gateway composition root:

1. Read `callbackQuery.data`, `callbackQuery.message.message_id`, and the chat ID.
2. If data starts with `ACTION_CALLBACK_PREFIX`, answer with a temporary “Working…” status but do not remove or settle the button.
3. Call `prototype.service.handleAction({ actionId, telegramMessageId })`.
4. On `applied` or `already-applied`, use the returned mutation receipt as the terminal truth.
5. Call `prototype.service.refreshControls(prototype.result.controls)` and edit the message keyboard. Controls disappear only after their registry record holds a receipt. Expired controls remain visible as expired; expiry is not a mutation receipt.
6. On `failed`, refresh controls so the button becomes `Retry …`; keep the failure visible in the action registry/journal. On `expired`, refresh controls so expiry stays visible without pretending it is a receipt.
7. On registry/claim failure, leave the existing keyboard intact and report the callback failure.

One action ID binds exactly one operation. The prototype registers:

- `Done` → fixture `resolve`
- `Dismiss` → fixture `acknowledge`
- `Snooze 4h` → fixture `snooze`
- `Open memory source` → direct verified URL, no callback

Do not treat Inngest acceptance, action expiry, or Telegram `answerCallbackQuery` as a mutation receipt.

The steering session must refresh the workspace lockfile when integrating this new package. This worker intentionally did not touch `pnpm-lock.yaml`.

## 5. Required phone acceptance

After the gateway worker lands the wiring above:

1. Print and review the exact payload.
2. Send it once to Joel’s real Telegram.
3. Touch `Done`, `Dismiss`, `Snooze 4h`, and `Open memory source`.
4. Read back each registry record and fixture adapter receipt.
5. Run an empty input and confirm no Telegram API call occurred.
6. Send “give me the digest” as normal text and confirm the agent chose `get_digest` without a channel interception.
