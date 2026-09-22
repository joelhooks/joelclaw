# @joelclaw/quiver-mcp

Loopback MCP server that puts [QuiverAI](https://docs.quiver.ai) SVG generation behind Executor. Same shape as `packages/imsg-mcp`: a bearer-guarded streamable HTTP endpoint on `127.0.0.1:4794`, run by a LaunchAgent in Joel's session so it can lease secrets from agent-secrets.

## Tools

| Tool | What it does | Spends credits |
| --- | --- | --- |
| `quiver_models` | List models this key can use, with operations and credit prices | no |
| `quiver_generate_svg` | Text prompt to one or more SVGs (`arrow-1.1` default, `arrow-1.1-max` for dense diagrams) | yes |
| `quiver_vectorize_image` | Raster image (URL or local path) to SVG (`arrow-2` default, `arrow-2-telos` for detail) | yes |

Outputs are written to `~/.joelclaw/quiver-out/<stamp>-<slug>[-n].svg` and the paths are returned. SVG markup is also returned inline when the total is under 64 KB.

## Secrets

- `quiver_api_key`: the Quiver API key.
- `quiver_mcp_bearer_token`: the bearer Executor sends. At least 32 bytes.

Both are leased at startup with `secrets lease <name> --ttl 24h`. Env overrides for local runs: `QUIVER_API_KEY`, `QUIVER_MCP_TOKEN`, `QUIVER_MCP_PORT`, `QUIVER_MCP_OUT_DIR`, `QUIVER_API_BASE_URL`.

## Run

```sh
pnpm --filter @joelclaw/quiver-mcp test
scripts/install-launch-agent.sh install     # LaunchAgent com.joel.quiver-mcp
curl -s http://127.0.0.1:4794/healthz
launchctl kickstart -k gui/501/com.joel.quiver-mcp
tail ~/.joelclaw/logs/quiver-mcp.error.log
```

## Executor

Integration slug `quiver`, remote streamable HTTP to `http://127.0.0.1:4794/mcp`, auth `header` (`Authorization: Bearer `). Register with `executor.mcp.addServer`; the bearer value goes in through the Executor Add-account form (`connections.createHandoff`), never through an agent message. Address pattern `tools.quiver.org.<connection>.<tool>`; discover with `tools.search({ namespace: "quiver", query: "" })`.

Rotate the bearer: `secrets update quiver_mcp_bearer_token`, kickstart the LaunchAgent, then edit the connection credential in the Executor UI.
