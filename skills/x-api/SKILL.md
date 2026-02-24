---
name: x-api
displayName: X/Twitter API
description: Read and post to X/Twitter via API. Check mentions, post tweets, search. Uses OAuth 2.0 user context with token refresh.
version: 0.1.0
author: joel
tags:
  - social
  - x
  - twitter
  - api
---

# X/Twitter API Skill

Basic X (Twitter) API access for the @joelclaw account until a proper CLI is built (ADR-0119).

## Authentication

OAuth 2.0 User Context with PKCE. Tokens expire every 2 hours — always refresh before use.

### Secrets (in agent-secrets)

- `x_oauth2_client_id` — OAuth 2.0 client ID
- `x_oauth2_client_secret` — OAuth 2.0 client secret
- `x_access_token` — Current access token (2hr TTL)
- `x_refresh_token` — Refresh token (use to get new access token)
- `x_bearer_token` — App-only bearer (read-only, no user context)

### Token Refresh (do this first, every time)

```bash
CLIENT_ID=$(secrets lease x_oauth2_client_id)
CLIENT_SECRET=$(secrets lease x_oauth2_client_secret)
REFRESH=$(secrets lease x_refresh_token)

RESPONSE=$(curl -s -X POST "https://api.twitter.com/2/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=refresh_token&refresh_token=$REFRESH")

# Extract new tokens
NEW_ACCESS=$(echo "$RESPONSE" | jq -r '.access_token')
NEW_REFRESH=$(echo "$RESPONSE" | jq -r '.refresh_token')

# Update secrets store
secrets set x_access_token "$NEW_ACCESS"
secrets set x_refresh_token "$NEW_REFRESH"

echo "Token refreshed"
```

**Always update both tokens** — the refresh token rotates on every use. Old refresh token is invalidated.

### Revoke leases after use

```bash
secrets revoke --all
```

## Account Info

- **Account**: @joelclaw
- **User ID**: 2022779096049311744
- **Scopes**: tweet.write, users.read, tweet.read, offline.access

## Common Operations

All operations use the access token as Bearer:

```bash
TOKEN=$(secrets lease x_access_token)
AUTH="Authorization: Bearer $TOKEN"
```

### Check mentions

```bash
curl -s -H "$AUTH" \
  "https://api.twitter.com/2/users/2022779096049311744/mentions?max_results=10&tweet.fields=created_at,author_id,text&expansions=author_id&user.fields=username,name"
```

### Get my timeline

```bash
curl -s -H "$AUTH" \
  "https://api.twitter.com/2/users/2022779096049311744/tweets?max_results=10&tweet.fields=created_at,public_metrics"
```

### Post a tweet

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "https://api.twitter.com/2/tweets" \
  -d '{"text": "your tweet text here"}'
```

### Reply to a tweet

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "https://api.twitter.com/2/tweets" \
  -d '{"text": "@username your reply", "reply": {"in_reply_to_tweet_id": "TWEET_ID"}}'
```

### Search recent tweets

```bash
curl -s -H "$AUTH" \
  "https://api.twitter.com/2/tweets/search/recent?query=joelclaw&max_results=10&tweet.fields=created_at,author_id,text"
```

### Get user by username

```bash
curl -s -H "$AUTH" \
  "https://api.twitter.com/2/users/by/username/USERNAME?user.fields=description,public_metrics"
```

### Delete a tweet

```bash
curl -s -X DELETE -H "$AUTH" \
  "https://api.twitter.com/2/tweets/TWEET_ID"
```

## Rate Limits

- Mentions: 180 requests / 15 min
- Post tweet: 200 tweets / 15 min (app-level)
- Search: 180 requests / 15 min
- User lookup: 300 requests / 15 min

## Rules

- **Never engage with shitcoin/scam mentions.** Ignore them entirely.
- **Never post financial advice or token endorsements.**
- **Joel approves all tweets before posting** unless explicitly told otherwise.
- **Always refresh token first** — access tokens expire every 2 hours.
- **Always revoke leases after use** — don't leave secrets in memory.
- **Always update both access_token and refresh_token** after refresh — the refresh token rotates.
