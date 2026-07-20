#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const configPath = process.env.JOELCLAW_CRITICAL_SEARCH_CONFIG
  ?? join(homedir(), ".config", "joelclaw", "critical-search-replicas.json")
const statePath = process.env.JOELCLAW_CRITICAL_SEARCH_SYNTHETIC_STATE
  ?? join(homedir(), ".joelclaw", "search", "replica-synthetic-state.json")
const maxStalenessSeconds = Number(process.env.JOELCLAW_CRITICAL_SEARCH_MAX_STALENESS_SECONDS ?? 300)
const timeoutMs = Number(process.env.JOELCLAW_CRITICAL_SEARCH_TIMEOUT_MS ?? 2_000)

type Replica = { name: string; url: string; maxStalenessSeconds?: number; token?: string }
type ProbeResult = {
  name: string
  url: string
  ok: boolean
  syncCheckAgeSeconds?: number | null
  replicaLagSeconds?: number | null
  recallFound?: number
  knowledgeFound?: number
  error?: string
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

async function postSearch(replica: Replica, body: Record<string, unknown>): Promise<{ found: number }> {
  if (!replica.token) throw new Error("replica authentication token is missing")
  const response = await fetch(`${replica.url.replace(/\/$/u, "")}/search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${replica.token}`,
      "content-type": "application/json",
      // The replica shim speaks HTTP/1.0-style one-shot connections; forbid
      // keep-alive reuse or a second request rides a socket the server closed.
      connection: "close",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`search HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`)
  return await response.json() as { found: number }
}

async function probe(replica: Replica): Promise<ProbeResult> {
  try {
    if (!replica.token) throw new Error("replica authentication token is missing")
    const base = replica.url.replace(/\/$/u, "")
    const healthResponse = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${replica.token}`, connection: "close" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!healthResponse.ok) throw new Error(`health HTTP ${healthResponse.status}`)
    const health = await healthResponse.json() as {
      ok?: boolean
      syncCheckAgeSeconds?: number | null
      replicaLagSeconds?: number | null
    }
    if (!health.ok) throw new Error("health reported unavailable")
    const budget = replica.maxStalenessSeconds ?? maxStalenessSeconds
    if (!Number.isFinite(health.syncCheckAgeSeconds)) {
      throw new Error("sync heartbeat is missing")
    }
    if (health.syncCheckAgeSeconds > budget) {
      throw new Error(`sync heartbeat is ${health.syncCheckAgeSeconds}s old; budget is ${budget}s`)
    }
    if (health.replicaLagSeconds !== null && health.replicaLagSeconds !== undefined
      && health.replicaLagSeconds > budget) {
      throw new Error(`replica lag is ${health.replicaLagSeconds}s; budget is ${budget}s`)
    }
    const recall = await postSearch(replica, {
      query: process.env.CRITICAL_SEARCH_SYNTHETIC_RECALL_QUERY ?? "memory observation",
      limit: 1,
      collections: ["observations", "memory_observations", "brain_pages"],
    })
    if (recall.found < 1) throw new Error("recall synthetic query returned no hits")
    const knowledge = await postSearch(replica, {
      query: process.env.CRITICAL_SEARCH_SYNTHETIC_KNOWLEDGE_QUERY ?? "SQLite critical search",
      limit: 1,
      collections: ["system_knowledge", "vault_notes"],
    })
    if (knowledge.found < 1) throw new Error("knowledge synthetic query returned no hits")
    return {
      name: replica.name,
      url: replica.url,
      ok: true,
      syncCheckAgeSeconds: health.syncCheckAgeSeconds,
      replicaLagSeconds: health.replicaLagSeconds,
      recallFound: recall.found,
      knowledgeFound: knowledge.found,
    }
  } catch (error) {
    return { name: replica.name, url: replica.url, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function notify(message: string): void {
  if (process.env.CRITICAL_SEARCH_NOTIFY === "0") return
  const cli = process.env.JOELCLAW_BIN ?? "joelclaw"
  const result = Bun.spawnSync([cli, "notify", "send", "--priority", "high", message], {
    stdout: "ignore",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    console.error(`notification failed: ${result.stderr.toString().slice(0, 300)}`)
  }
}

const config = readJson<{ replicas?: Replica[]; tokenFile?: string }>(configPath, {})
const sharedToken = config.tokenFile ? readFileSync(config.tokenFile, "utf8").trim() : undefined
const replicas = (config.replicas ?? []).map((replica) => ({ ...replica, token: replica.token ?? sharedToken }))
if (replicas.length !== 2) throw new Error(`expected exactly two configured replicas in ${configPath}`)
const previous = readJson<{ overall?: "ok" | "failed" }>(statePath, {})
const results = await Promise.all(replicas.map(probe))
const overall = results.every((result) => result.ok) ? "ok" : "failed"
const checkedAt = new Date().toISOString()
mkdirSync(dirname(statePath), { recursive: true })
writeFileSync(statePath, `${JSON.stringify({ checkedAt, overall, results }, null, 2)}\n`, { mode: 0o600 })

if (overall === "failed" && previous.overall !== "failed") {
  const failures = results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.error}`).join("; ")
  notify(`Critical-search replica synthetic failed: ${failures}`)
} else if (overall === "ok" && previous.overall === "failed") {
  notify("Critical-search replica synthetic recovered: both NAS replicas answer recall and knowledge queries.")
}

console.log(JSON.stringify({ ok: overall === "ok", checkedAt, results }, null, 2))
if (overall !== "ok") process.exitCode = 1
