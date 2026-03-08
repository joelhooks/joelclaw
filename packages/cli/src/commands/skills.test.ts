import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { __skillsTestUtils } from "./skills"

const tempDirs: string[] = []

const rememberTempDir = (dir: string) => {
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("skills command helpers", () => {
  test("parseRunOutput decodes valid JSON object output", () => {
    const parsed = __skillsTestUtils.parseRunOutput(
      JSON.stringify({
        timestamp: "2026-02-28T21:05:04.410Z",
        isDeepReview: false,
        findings: { total: 2, stalePatterns: 2 },
        details: [{ type: "stale-pattern", skill: "skill-review", detail: "outdated reference" }],
      }),
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.findings?.total).toBe(2)
    expect(parsed?.details?.[0]?.skill).toBe("skill-review")
  })

  test("parseRunOutput returns null for non-JSON output", () => {
    expect(__skillsTestUtils.parseRunOutput("not json")).toBeNull()
    expect(__skillsTestUtils.parseRunOutput(42 as unknown as string)).toBeNull()
  })

  test("resolveSkillSource finds repo-local canonical skill directories", () => {
    const repoRoot = rememberTempDir(mkdtempSync(join(tmpdir(), "skills-source-")))
    const skillFile = join(repoRoot, "skills", "demo-skill", "SKILL.md")
    mkdirSync(dirname(skillFile), { recursive: true })
    writeFileSync(skillFile, "---\nname: demo-skill\n---\n", "utf8")

    const resolved = __skillsTestUtils.resolveSkillSource({
      name: "demo-skill",
      cwd: join(repoRoot, "packages", "cli"),
      homeDir: repoRoot,
    })

    expect(resolved.skillFile).toBe(skillFile)
    expect(resolved.skillDir).toBe(join(repoRoot, "skills", "demo-skill"))
    expect(resolved.sourceRoot).toBe(repoRoot)
  })

  test("ensureSkillLink creates and updates consumer symlinks", () => {
    const repoRoot = rememberTempDir(mkdtempSync(join(tmpdir(), "skills-ensure-")))
    const homeDir = rememberTempDir(mkdtempSync(join(tmpdir(), "skills-home-")))
    const sourceDir = join(repoRoot, "skills", "agent-workloads")
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: agent-workloads\n---\n", "utf8")

    const created = __skillsTestUtils.ensureSkillLink({
      sourceDir,
      name: "agent-workloads",
      consumer: "pi",
      homeDir,
    })

    expect(created.status).toBe("created")
    expect(existsSync(created.target)).toBe(true)
    expect(resolve(dirname(created.target), readlinkSync(created.target))).toBe(sourceDir)

    const unchanged = __skillsTestUtils.ensureSkillLink({
      sourceDir,
      name: "agent-workloads",
      consumer: "pi",
      homeDir,
    })

    expect(unchanged.status).toBe("unchanged")

    const replacementSource = join(repoRoot, "skills", "cli-design")
    mkdirSync(replacementSource, { recursive: true })
    writeFileSync(join(replacementSource, "SKILL.md"), "---\nname: cli-design\n---\n", "utf8")

    const updated = __skillsTestUtils.ensureSkillLink({
      sourceDir: replacementSource,
      name: "agent-workloads",
      consumer: "pi",
      homeDir,
    })

    expect(updated.status).toBe("updated")
    expect(resolve(dirname(updated.target), readlinkSync(updated.target))).toBe(replacementSource)
  })
})
