/**
 * joelclaw x — X/Twitter operations via OAuth2 + xdk-typescript
 *
 * Commands:
 *   joelclaw x tweet "text"       — Post a tweet
 *   joelclaw x whoami             — Check authenticated user
 *   joelclaw x refresh            — Refresh OAuth2 access token
 *   joelclaw x search "query"     — Search recent posts
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { execSync } from "child_process"

function leaseSecret(name: string): string {
  return execSync(`secrets lease ${name} --ttl 5m`, { encoding: "utf-8" }).trim()
}

async function getClient() {
  const { Client } = await import("@xdevplatform/xdk")
  const accessToken = leaseSecret("x_access_token")
  return new Client({ accessToken })
}

async function refreshTokens(): Promise<{ accessToken: string; refreshToken?: string }> {
  const { OAuth2 } = await import("@xdevplatform/xdk")
  const clientId = leaseSecret("x_oauth2_client_id")
  const clientSecret = leaseSecret("x_oauth2_client_secret")
  const refreshToken = leaseSecret("x_refresh_token")

  const oauth2 = new OAuth2({
    clientId,
    clientSecret,
    redirectUri: "http://localhost:3000/callback",
    scope: ["tweet.read", "tweet.write", "users.read", "offline.access"],
  })

  const token = await oauth2.refreshToken(refreshToken)

  execSync(`printf '%s' '${token.access_token}' | secrets update x_access_token`, { stdio: "pipe" })
  if (token.refresh_token) {
    execSync(`printf '%s' '${token.refresh_token}' | secrets update x_refresh_token`, { stdio: "pipe" })
  }

  return { accessToken: token.access_token, refreshToken: token.refresh_token }
}

/** Print JSON and exit. The xdk http client keeps the event loop alive. */
function out(obj: Record<string, unknown>, code = 0): never {
  console.log(JSON.stringify(obj, null, 2))
  process.exit(code)
}

/** Wrap an async X API call with auto-refresh on 401 */
async function withAutoRefresh<T>(fn: (client: Awaited<ReturnType<typeof getClient>>) => Promise<T>): Promise<T> {
  let client = await getClient()
  try {
    return await fn(client)
  } catch (err: any) {
    if (err?.status === 401 || err?.message?.includes("401")) {
      await refreshTokens()
      client = await getClient()
      return await fn(client)
    }
    throw err
  }
}

// ── Tweet ────────────────────────────────────────────────────────────

const tweetCmd = Command.make(
  "tweet",
  {
    text: Args.text({ name: "text" }).pipe(
      Args.withDescription("Tweet text content")
    ),
    replyTo: Options.text("reply-to").pipe(
      Options.withDescription("Tweet ID to reply to"),
      Options.optional
    ),
    quote: Options.text("quote").pipe(
      Options.withDescription("Tweet ID to quote"),
      Options.optional
    ),
  },
  ({ text, replyTo, quote }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          const body: any = { text }
          if (replyTo._tag === "Some") body.reply = { inReplyToTweetId: replyTo.value }
          if (quote._tag === "Some") body.quoteTweetId = quote.value

          const result: any = await withAutoRefresh(c => c.posts.create(body))
          const tweetId = result?.data?.id

          out({
            ok: true,
            command: "x tweet",
            result: {
              id: tweetId,
              text: result?.data?.text,
              url: tweetId ? `https://x.com/joelclaw/status/${tweetId}` : null,
            },
            next_actions: [
              { command: `joelclaw x tweet "reply text" --reply-to ${tweetId}`, description: "Reply to this tweet" },
              { command: "joelclaw x whoami", description: "Check auth status" },
            ],
          })
        },
        catch: (err: any) => {
          out({
            ok: false,
            command: "x tweet",
            error: { message: err?.message ?? String(err), status: err?.status, data: err?.data },
            next_actions: [
              { command: "joelclaw x refresh", description: "Refresh access token" },
            ],
          }, 1)
        },
      })
    })
)

// ── Whoami ───────────────────────────────────────────────────────────

const whoamiCmd = Command.make("whoami", {}, () =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        const result: any = await withAutoRefresh(c =>
          c.users.getMe({ userFields: ["id", "name", "username", "description", "public_metrics"] })
        )
        out({
          ok: true,
          command: "x whoami",
          result: result?.data ?? result,
          next_actions: [{ command: "joelclaw x tweet \"hello\"", description: "Post a tweet" }],
        })
      },
      catch: (err: any) => {
        out({
          ok: false,
          command: "x whoami",
          error: { message: err?.message ?? String(err), status: err?.status },
          next_actions: [{ command: "joelclaw x refresh", description: "Refresh access token" }],
        }, 1)
      },
    })
  })
)

// ── Refresh ──────────────────────────────────────────────────────────

const refreshCmd = Command.make("refresh", {}, () =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        const result = await refreshTokens()
        out({
          ok: true,
          command: "x refresh",
          result: {
            access_token: result.accessToken.slice(0, 20) + "...",
            refresh_token_rotated: !!result.refreshToken,
          },
          next_actions: [
            { command: "joelclaw x whoami", description: "Verify new token" },
            { command: "joelclaw x tweet \"test\"", description: "Post a tweet" },
          ],
        })
      },
      catch: (err: any) => {
        out({
          ok: false,
          command: "x refresh",
          error: { message: err?.message ?? String(err) },
          next_actions: [
            { command: "bun run packages/cli/scripts/x-oauth-flow.ts", description: "Re-run OAuth2 flow" },
          ],
        }, 1)
      },
    })
  })
)

// ── Search ───────────────────────────────────────────────────────────

const searchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }).pipe(
      Args.withDescription("Search query")
    ),
    count: Options.integer("count").pipe(
      Options.withAlias("n"),
      Options.withDefault(10),
      Options.withDescription("Max results (default: 10)")
    ),
  },
  ({ query, count }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          const result: any = await withAutoRefresh(c =>
            c.posts.searchRecent(query, {
              maxResults: count,
              tweetFields: ["created_at", "author_id", "public_metrics", "text"],
            })
          )
          out({
            ok: true,
            command: "x search",
            result: {
              query,
              count: result?.data?.length ?? 0,
              posts: result?.data ?? [],
              meta: result?.meta,
            },
            next_actions: [
              { command: `joelclaw x tweet "reply" --reply-to TWEET_ID`, description: "Reply to a result" },
            ],
          })
        },
        catch: (err: any) => {
          out({
            ok: false,
            command: "x search",
            error: { message: err?.message ?? String(err), status: err?.status },
          }, 1)
        },
      })
    })
)

// ── Root x command ───────────────────────────────────────────────────

export const xCmd = Command.make("x", {}, () =>
  Console.log(JSON.stringify({
    ok: true,
    command: "x",
    description: "X/Twitter operations for @joelclaw",
    subcommands: {
      tweet: "joelclaw x tweet \"text\" [--reply-to ID] [--quote ID]",
      whoami: "joelclaw x whoami",
      refresh: "joelclaw x refresh",
      search: "joelclaw x search \"query\" [--count N]",
    },
  }, null, 2))
).pipe(
  Command.withSubcommands([tweetCmd, whoamiCmd, refreshCmd, searchCmd])
)
