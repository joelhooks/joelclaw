import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

describe("publish-replica", () => {
  test("concurrent publishers cannot replace a newer snapshot with an older one", async () => {
    if (!Bun.which("sha256sum")) throw new Error("sha256sum is required for replica publication tests")
    const root = join(tmpdir(), `critical-replica-publish-${crypto.randomUUID()}`)
    roots.push(root)
    const data = join(root, "data")
    mkdirSync(data, { recursive: true })
    const oldDb = join(root, "old.db")
    const newDb = join(root, "new.db")
    const oldState = join(root, "old.json")
    const newState = join(root, "new.json")
    writeFileSync(oldDb, "old snapshot")
    writeFileSync(newDb, "new snapshot")
    writeFileSync(oldState, JSON.stringify({
      sourceVersion: "2026-07-20T01:00:00.100Z",
      sourceMtime: "2026-07-20T01:00:00Z",
      sha256: sha256("old snapshot"),
    }))
    writeFileSync(newState, JSON.stringify({
      sourceVersion: "2026-07-20T02:00:00.100Z",
      sourceMtime: "2026-07-20T02:00:00Z",
      sha256: sha256("new snapshot"),
    }))
    const script = "infra/critical-search-replica/publish-replica.sh"
    const oldPublish = Bun.spawn([
      script, data, oldDb, sha256("old snapshot"), "2026-07-20T01:00:00.100Z", "2026-07-20T01:00:00Z", oldState,
    ])
    const newPublish = Bun.spawn([
      script, data, newDb, sha256("new snapshot"), "2026-07-20T02:00:00.100Z", "2026-07-20T02:00:00Z", newState,
    ])
    const codes = await Promise.all([oldPublish.exited, newPublish.exited])
    expect(codes.every((code) => code === 0 || code === 3)).toBe(true)
    expect(readFileSync(join(data, "critical.db"), "utf8")).toBe("new snapshot")
    expect(readFileSync(join(data, "sync-state.json"), "utf8")).toContain("02:00:00Z")
  })

  test("reclaims a lock left by a dead process without deleting its receipt", async () => {
    if (!Bun.which("sha256sum")) throw new Error("sha256sum is required for replica publication tests")
    const root = join(tmpdir(), `critical-replica-stale-lock-${crypto.randomUUID()}`)
    roots.push(root)
    const data = join(root, "data")
    const lock = join(data, ".publish-lockdir")
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, "owner"), "previous-boot|999999|dead-process\n")
    const db = join(root, "snapshot.db")
    const state = join(root, "state.json")
    const version = "2026-07-20T03:00:00.100Z"
    writeFileSync(db, "recovered snapshot")
    writeFileSync(state, JSON.stringify({ sourceVersion: version, sourceMtime: "2026-07-20T03:00:00Z", sha256: sha256("recovered snapshot") }))
    const code = await Bun.spawn([
      "infra/critical-search-replica/publish-replica.sh",
      data,
      db,
      sha256("recovered snapshot"),
      version,
      "2026-07-20T03:00:00Z",
      state,
    ]).exited
    expect(code).toBe(0)
    expect(readFileSync(join(data, "critical.db"), "utf8")).toBe("recovered snapshot")
    expect(readdirSync(data).some((entry) => entry.startsWith(".publish-lockdir.stale."))).toBe(true)
  })

  test("fails closed for the same source version with a different checksum", async () => {
    if (!Bun.which("sha256sum")) throw new Error("sha256sum is required for replica publication tests")
    const root = join(tmpdir(), `critical-replica-equal-version-${crypto.randomUUID()}`)
    roots.push(root)
    const data = join(root, "data")
    mkdirSync(data, { recursive: true })
    const firstDb = join(root, "first.db")
    const secondDb = join(root, "second.db")
    const firstState = join(root, "first.json")
    const secondState = join(root, "second.json")
    const version = "2026-07-20T01:00:00.123Z"
    writeFileSync(firstDb, "first snapshot")
    writeFileSync(secondDb, "second snapshot")
    writeFileSync(firstState, JSON.stringify({ sourceVersion: version, sourceMtime: "2026-07-20T01:00:00Z", sha256: sha256("first snapshot") }))
    writeFileSync(secondState, JSON.stringify({ sourceVersion: version, sourceMtime: "2026-07-20T01:00:00Z", sha256: sha256("second snapshot") }))
    const script = "infra/critical-search-replica/publish-replica.sh"
    expect(await Bun.spawn([
      script, data, firstDb, sha256("first snapshot"), version, "2026-07-20T01:00:00Z", firstState,
    ]).exited).toBe(0)
    expect(await Bun.spawn([
      script, data, secondDb, sha256("second snapshot"), version, "2026-07-20T01:00:00Z", secondState,
    ]).exited).toBe(4)
    expect(readFileSync(join(data, "critical.db"), "utf8")).toBe("first snapshot")
  })
})
