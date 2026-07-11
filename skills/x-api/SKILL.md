---
name: x-api
displayName: X/Twitter API
description: Read and post to X/Twitter via API. Check mentions, post tweets, search. Use app bearer tokens for read-only fetches and OAuth 1.0a user context for account actions.
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

**Recommended for read-only access: app bearer token**

There is no stored `x_bot_bearer_token` secret right now. Derive the app bearer token from the X app consumer key + secret, then use that bearer token for read-only endpoints like tweet lookup.

```bash
python3 <<'PY'
import base64, json, subprocess
from urllib import request, parse


def lease(name: str) -> str:
    raw = subprocess.check_output(['secrets', 'lease', name], text=True)
    data = json.loads(raw)
    return data.get('secret') or data.get('result') or raw.strip()

ck = lease('x_consumer_key')
cs = lease('x_consumer_secret')
cred = base64.b64encode(f'{ck}:{cs}'.encode()).decode()

req = request.Request(
    'https://api.twitter.com/oauth2/token',
    data=parse.urlencode({'grant_type': 'client_credentials'}).encode(),
    headers={
        'Authorization': f'Basic {cred}',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    method='POST',
)
with request.urlopen(req) as r:
    bearer = json.loads(r.read().decode())['access_token']

req2 = request.Request(
    'https://api.twitter.com/2/tweets/TWEET_ID',
    headers={'Authorization': f'Bearer {bearer}'},
)
with request.urlopen(req2) as r:
    print(r.read().decode())
PY

secrets revoke --all
```

Use this for:
- reading a specific tweet/post
- fetching public user metadata
- recent search
- full-archive search when the app has access
- reply/context passes for source ingestion
- other public read-only X v2 endpoints

### Reply/context pass for ingestion

When ingesting an X post/article as a source, do a reply pass before writing the final note. The replies often contain the correction, missing caveat, source link, or better framing. Do not blindly archive the whole reply swamp; extract the high-signal replies and keep receipts.

Minimum pass:

1. Fetch the root post with `conversation_id`, `author_id`, `created_at`, `entities`, `public_metrics`, `referenced_tweets`, `note_tweet`, and `article` when available.
2. Search replies with `conversation_id:ROOT_ID is:reply -is:retweet`.
3. Capture high-signal replies: author clarification, author thread continuation, cited source/link, strong objection, correction, implementation detail, or unusually crisp language.
4. Store reply receipts with `tweet_id`, author handle/name, created time, URL, text basis, metrics, and why it matters.
5. In the Brain/source note, separate the root quote from **Reply signals** so public claims do not blur root-author text with commenter interpretation.

For posts inside the recent-search window:

```bash
# After deriving bearer as above:
curl "https://api.x.com/2/tweets/search/recent?query=conversation_id%3AROOT_ID%20is%3Areply%20-is%3Aretweet&max_results=100&tweet.fields=author_id,conversation_id,created_at,entities,id,in_reply_to_user_id,note_tweet,public_metrics,referenced_tweets,text&expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id&user.fields=username,name,verified,verified_type" \
  -H "Authorization: Bearer $bearer"
```

For older posts, use Full-Archive Search when access allows it; otherwise fall back to browser inspection and mark the limitation in the verification note.

### Full-Archive Search

The bot app can call Full-Archive Search if the access tier permits it. Do not use Recent Search for YTD/backfill research; it rejects older `start_time` values.

```bash
# After deriving bearer as above:
curl "https://api.x.com/2/tweets/search/all?query=from%3Athreepointone%20-is%3Areply&start_time=2026-01-01T00%3A00%3A00Z&end_time=2026-05-02T00%3A00%3A00Z&max_results=100&tweet.fields=created_at,public_metrics" \
  -H "Authorization: Bearer $bearer"
```

Notes:
- Full archive endpoint: `/2/tweets/search/all`.
- Recent endpoint: `/2/tweets/search/recent`; last-7-days style window only.
- `tweet.fields=context_annotations` forces `max_results <= 100`; X returns 400 if paired with `max_results=500`.
- Full-archive docs: https://docs.x.com/x-api/posts/search/quickstart/full-archive-search


**Alternative: OAuth 1.0a User Context** (for posting and account actions)

Tokens do not expire — no refresh dance needed.

### Secrets (in agent-secrets)

- `x_consumer_key` — API Key (OAuth 1.0a consumer key)
- `x_consumer_secret` — API Key Secret (OAuth 1.0a consumer secret)
- `x_access_token` — Access Token (OAuth 1.0a, format: `numeric-alphanumeric`)
- `x_access_token_secret` — Access Token Secret (OAuth 1.0a)

#### @joelhooks / `shitrat-joel` app

Use these scoped secret names for Joel's personal X account so they don't collide with the @joelclaw bot app:

- `x_joelhooks_consumer_key`
- `x_joelhooks_consumer_secret`
- `x_joelhooks_bearer_token`
- `x_joelhooks_access_token`
- `x_joelhooks_access_token_secret`

PIN OAuth note, 2026-06-28: `https://api.x.com/oauth/authorize?...` showed “There is no request token.” Regenerating with `https://api.twitter.com/oauth/request_token` and opening `https://twitter.com/oauth/authorize?force_login=true&oauth_token=...` worked for `shitrat-joel` → @joelhooks.

Auth verification, 2026-06-28: `x_joelhooks_access_token` + `x_joelhooks_access_token_secret` verified with `GET https://api.twitter.com/2/users/me` as `@joelhooks` / user id `12087242`.

Bookmark caveat: `GET /2/users/12087242/bookmarks` returned `403 Unsupported Authentication` with OAuth 1.0a. X requires OAuth 2.0 User Context / PKCE with `bookmark.read`, `tweet.read`, and `users.read` for bookmarks. Do not assume the saved OAuth 1.0a token can read bookmarks.

### Signing requests

OAuth 1.0a requires cryptographic signing. Use `requests-oauthlib` (Python) or equivalent:

```bash
export CK=$(secrets lease x_consumer_key)
export CS=$(secrets lease x_consumer_secret)
export AT=$(secrets lease x_access_token)
export ATS=$(secrets lease x_access_token_secret)

uv run --with requests-oauthlib python3 << 'PYEOF'
import os
from requests_oauthlib import OAuth1Session

client = OAuth1Session(
    os.environ['CK'],
    client_secret=os.environ['CS'],
    resource_owner_key=os.environ['AT'],
    resource_owner_secret=os.environ['ATS'],
)

r = client.get("https://api.twitter.com/2/users/me")
print(r.json())
PYEOF
```

### Revoke leases after use

```bash
secrets revoke --all
```

## Account Info

- **Account**: @joelclaw
- **User ID**: 2022779096049311744
- **Scopes**: Read and write (OAuth 1.0a app permissions)

### @joelhooks Account Info

- **Account**: @joelhooks
- **User ID**: 12087242
- **App**: `shitrat-joel`
- **OAuth 1.0a status**: saved and verified for user-context actions that allow OAuth 1.0a
- **Bookmarks**: not available through OAuth 1.0a; needs OAuth 2.0 PKCE user token with `bookmark.read`

## Common Operations

Read-only lookups can use the app bearer-token flow above.

Posting, replying, following, deleting, and account-scoped actions require OAuth 1.0a signing. Use the Python pattern from Authentication section above, then:

### Common API calls (inside OAuth1Session)

```python
# Check mentions
r = client.get("https://api.twitter.com/2/users/2022779096049311744/mentions",
    params={"max_results": 10, "tweet.fields": "created_at,author_id,text",
            "expansions": "author_id", "user.fields": "username,name"})

# Get my timeline
r = client.get("https://api.twitter.com/2/users/2022779096049311744/tweets",
    params={"max_results": 10, "tweet.fields": "created_at,public_metrics"})

# Post a tweet
r = client.post("https://api.twitter.com/2/tweets", json={"text": "your tweet"})

# Reply to a tweet
r = client.post("https://api.twitter.com/2/tweets",
    json={"text": "@user reply", "reply": {"in_reply_to_tweet_id": "TWEET_ID"}})

# Search recent tweets
r = client.get("https://api.twitter.com/2/tweets/search/recent",
    params={"query": "joelclaw", "max_results": 10, "tweet.fields": "created_at,author_id,text"})

# Get user by username
r = client.get("https://api.twitter.com/2/users/by/username/USERNAME",
    params={"user.fields": "description,public_metrics"})

# Follow a user
my_id = "2022779096049311744"
r = client.post(f"https://api.twitter.com/2/users/{my_id}/following",
    json={"target_user_id": "TARGET_USER_ID"})

# Delete a tweet
r = client.delete("https://api.twitter.com/2/tweets/TWEET_ID")
```

## X Articles (Long-form Posts)

First try the v2 tweet lookup with `tweet.fields=article`. Some X Articles return `article.title` and `article.plain_text` directly in the tweet payload. Store that API payload as the source receipt when available.

If `article.plain_text` is missing, the tweet body is only a `t.co` link, or the article endpoint/browser auth blocks extraction, use agent-browser as the fallback:

```bash
agent-browser open "https://x.com/USERNAME/status/TWEET_ID"
agent-browser snapshot
agent-browser close
```

Use this for any tweet where `article.title` is present in the API response or the `expanded_url` points to `x.com/i/article/...` but the API does not include usable article text.

For capturing X posts/articles as discoveries, use `joelclaw discover URL -c "context"` — the discovery pipeline will handle enrichment. If the pipeline can't extract content (auth-gated), fall back to X API + reply/context pass + manual Brain/source note.

## Rate Limits

- Mentions: 180 requests / 15 min
- Post tweet: 200 tweets / 15 min (app-level)
- Search: 180 requests / 15 min
- User lookup: 300 requests / 15 min

## Rules

- **Never engage with shitcoin/scam mentions.** Ignore them entirely.
- **Never post financial advice or token endorsements.**
- **Joel approves all tweets before posting** unless explicitly told otherwise.
- **Always revoke leases after use** — don't leave secrets in memory.
- **OAuth 1.0a tokens don't expire** — no refresh needed. If auth fails, tokens were regenerated in the developer portal.
