# ADR-0119: X/Twitter CLI Integration

**Status**: accepted  
**Date**: 2026-02-23  
**Deciders**: Joel  

## Context

joelclaw needs the ability to post tweets and interact with the X API under the @joelclaw account. This enables:
- System announcements and status updates
- Agent-driven content publishing
- Social presence automation

Previous attempt used `@steipete/bird` (browser cookie-based GraphQL scraping) which hit anti-automation blocks (error 226). The official X API v2 with OAuth2 is the correct path.

## Decision

Use the official `@xdevplatform/xdk` TypeScript SDK (installed from GitHub) with OAuth2 PKCE authentication.

### Architecture

- **SDK**: `@xdevplatform/xdk` (github:xdevplatform/xdk-typescript) — official X API v2 SDK
- **Auth**: OAuth2 PKCE flow with offline.access for refresh tokens
- **Credentials**: Stored in agent-secrets as `x_oauth2_client_id`, `x_oauth2_client_secret`, `x_access_token`, `x_refresh_token`
- **CLI**: `joelclaw x {tweet|whoami|refresh|search}` — Effect CLI command in `packages/cli/src/commands/x.ts`
- **Token refresh**: Automatic retry on 401 with token refresh, plus manual `joelclaw x refresh`
- **OAuth flow script**: `packages/cli/scripts/x-oauth-flow.ts` — one-shot PKCE flow with localhost:3000 callback

### Secrets

| Name | Purpose |
|------|---------|
| `x_oauth2_client_id` | OAuth2 client ID from X developer portal |
| `x_oauth2_client_secret` | OAuth2 client secret |
| `x_access_token` | Bearer token for API calls (2h TTL, auto-refreshed) |
| `x_refresh_token` | Offline refresh token (rotated on each refresh) |
| `x_consumer_key` | OAuth1 API key (stored but unused — OAuth2 preferred) |
| `x_consumer_secret` | OAuth1 API secret (stored but unused) |
| `x_bearer_token` | App-only bearer (stored but unused) |

### Commands

```
joelclaw x tweet "text" [--reply-to ID] [--quote ID]
joelclaw x whoami
joelclaw x refresh
joelclaw x search "query" [--count N]
```

## Consequences

- Access token expires every 2 hours; refresh token must be used and rotated
- If refresh token is lost/expired, re-run the OAuth flow script
- Future: wire into Inngest events so agents/pipelines can trigger tweets
- Future: add media upload support via `client.media`

## Alternatives Considered

- **@steipete/bird** (browser cookie scraping): Hit anti-automation error 226. Not reliable for agent use.
- **OAuth1**: More complex signature handling, xdk supports it but OAuth2 PKCE is recommended by X.
