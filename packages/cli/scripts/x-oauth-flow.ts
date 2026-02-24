#!/usr/bin/env bun
/**
 * OAuth2 PKCE flow to get access token + refresh token for @joelclaw.
 *
 * Usage:
 *   bun run packages/cli/scripts/x-oauth-flow.ts
 *
 * 1. Opens authorization URL
 * 2. Starts localhost:3000 to catch the redirect
 * 3. Exchanges code for tokens
 * 4. Prints secrets add commands
 */

import { execSync } from "child_process"

function leaseSecret(name: string): string {
  return execSync(`secrets lease ${name} --ttl 5m`, { encoding: "utf-8" }).trim()
}

async function main() {
  console.log("🔑 X OAuth2 PKCE Flow for @joelclaw\n")

  const clientId = leaseSecret("x_oauth2_client_id")
  const clientSecret = leaseSecret("x_oauth2_client_secret")

  console.log(`✅ Client ID: ${clientId.slice(0, 12)}...`)
  console.log(`✅ Client Secret: ${clientSecret.slice(0, 12)}...\n`)

  const { OAuth2 } = await import("@xdevplatform/xdk")

  const oauth2 = new OAuth2({
    clientId,
    clientSecret,
    redirectUri: "http://localhost:3000/callback",
    scope: [
      "tweet.read",
      "tweet.write",
      "users.read",
      "offline.access", // for refresh token
    ],
  })

  // Generate PKCE
  const { generateCodeVerifier, generateCodeChallenge } = await import("@xdevplatform/xdk")
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  await oauth2.setPkceParameters(codeVerifier, codeChallenge)

  const state = crypto.randomUUID()
  const authUrl = await oauth2.getAuthorizationUrl(state)

  console.log("🌐 Opening authorization URL...\n")
  console.log(`   ${authUrl}\n`)

  // Open in browser
  try {
    execSync(`open "${authUrl}"`)
  } catch {
    console.log("   (Could not auto-open — copy the URL above into your browser)\n")
  }

  // Start a tiny HTTP server to catch the redirect
  console.log("📡 Waiting for redirect on http://localhost:3000/callback ...\n")

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for callback (120s)"))
    }, 120_000)

    const server = Bun.serve({
      port: 3000,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code")
          const returnedState = url.searchParams.get("state")
          const error = url.searchParams.get("error")

          if (error) {
            clearTimeout(timeout)
            server.stop()
            reject(new Error(`OAuth error: ${error} - ${url.searchParams.get("error_description")}`))
            return new Response(`<h1>❌ Error: ${error}</h1><p>${url.searchParams.get("error_description")}</p>`, {
              headers: { "Content-Type": "text/html" },
            })
          }

          if (!code) {
            return new Response("<h1>❌ No code in callback</h1>", {
              headers: { "Content-Type": "text/html" },
              status: 400,
            })
          }

          if (returnedState !== state) {
            clearTimeout(timeout)
            server.stop()
            reject(new Error("State mismatch — possible CSRF"))
            return new Response("<h1>❌ State mismatch</h1>", {
              headers: { "Content-Type": "text/html" },
              status: 400,
            })
          }

          clearTimeout(timeout)
          // Give the response time to send before stopping server
          setTimeout(() => {
            server.stop()
            resolve(code)
          }, 500)

          return new Response(
            "<h1>✅ Authorized!</h1><p>You can close this tab. Return to terminal.</p>",
            { headers: { "Content-Type": "text/html" } }
          )
        }
        return new Response("Not found", { status: 404 })
      },
    })
  })

  console.log(`✅ Got authorization code: ${code.slice(0, 16)}...\n`)
  console.log("🔄 Exchanging code for tokens...\n")

  const token = await oauth2.exchangeCode(code, codeVerifier)

  console.log("✅ SUCCESS!\n")
  console.log(`   access_token:  ${token.access_token.slice(0, 20)}...`)
  console.log(`   token_type:    ${token.token_type}`)
  console.log(`   expires_in:    ${token.expires_in}s`)
  console.log(`   refresh_token: ${token.refresh_token ? token.refresh_token.slice(0, 20) + "..." : "none"}`)
  console.log(`   scope:         ${token.scope}\n`)

  // Store them
  console.log("📦 Storing tokens in secrets...\n")

  try {
    execSync(`printf '%s' '${token.access_token}' | secrets add x_access_token 2>/dev/null || printf '%s' '${token.access_token}' | secrets update x_access_token`, { stdio: "pipe" })
    console.log("   ✅ x_access_token stored")
  } catch (e: any) {
    console.log(`   ⚠️  x_access_token: ${e.message}`)
  }

  if (token.refresh_token) {
    try {
      execSync(`printf '%s' '${token.refresh_token}' | secrets add x_refresh_token 2>/dev/null || printf '%s' '${token.refresh_token}' | secrets update x_refresh_token`, { stdio: "pipe" })
      console.log("   ✅ x_refresh_token stored")
    } catch (e: any) {
      console.log(`   ⚠️  x_refresh_token: ${e.message}`)
    }
  }

  console.log("\n🎉 Done! You can now use `joelclaw x tweet \"hello world\"`\n")
  process.exit(0)
}

main().catch((err) => {
  console.error("❌ Error:", err.message ?? err)
  process.exit(1)
})
