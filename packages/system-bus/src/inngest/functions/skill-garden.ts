import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { infer } from "../../lib/inference";
import { inngest } from "../client";

const REPO_SKILLS = resolve(
  process.env.HOME || "/Users/joel",
  "Code/joelhooks/joelclaw/skills"
);

const HOME_SKILL_DIRS = [
  resolve(process.env.HOME || "/Users/joel", ".agents/skills"),
  resolve(process.env.HOME || "/Users/joel", ".pi/agent/skills"),
];

const AGENTS_MD = resolve(
  process.env.HOME || "/Users/joel",
  "Code/joelhooks/joelclaw/AGENTS.md"
);

/** Known stale patterns — things that should NOT appear in current skills */
const STALE_PATTERNS: Array<{ pattern: RegExp; label: string; note: string }> =
  [
    { pattern: /\bk3d\b/i, label: "k3d", note: "Replaced by Talos on Colima" },
    {
      pattern: /\bk3s\b(?!\s*v)/i,
      label: "k3s",
      note: "Replaced by Talos on Colima",
    },
    {
      pattern: /\bqdrant\b/i,
      label: "qdrant",
      note: "Removed from cluster — using Typesense vector search",
    },
    {
      pattern: /launchctl.*system-bus/i,
      label: "launchd worker",
      note: "Worker runs in k8s now, not launchd",
    },
    {
      pattern: /~\/Code\/system-bus-worker/,
      label: "old worker path",
      note: "Worker source is in monorepo packages/system-bus/",
    },
    {
      pattern: /~\/Code\/joelhooks\/igs\//,
      label: "old igs path",
      note: "CLI source is packages/cli/ in the monorepo",
    },
    {
      pattern: /\bigs\b(?!\s+is\b)/,
      label: "igs alias",
      note: "CLI renamed to joelclaw — igs is legacy",
    },
  ];

interface Finding {
  type:
    | "broken-symlink"
    | "non-canonical"
    | "missing-frontmatter"
    | "stale-pattern"
    | "orphan"
    | "llm-staleness";
  skill: string;
  location: string;
  detail: string;
}

function checkBrokenSymlinks(): Finding[] {
  const findings: Finding[] = [];
  for (const dir of HOME_SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) {
          try {
            realpathSync(full);
          } catch {
            findings.push({
              type: "broken-symlink",
              skill: entry,
              location: dir,
              detail: `Dead symlink: ${full}`,
            });
          }
        }
      } catch {
        // skip
      }
    }
  }
  return findings;
}

function checkNonCanonical(): Finding[] {
  const findings: Finding[] = [];
  for (const dir of HOME_SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          // REAL DIR — should it be a symlink to repo?
          const repoPath = join(REPO_SKILLS, entry);
          if (existsSync(repoPath)) {
            findings.push({
              type: "non-canonical",
              skill: entry,
              location: dir,
              detail: `REAL DIR should be symlink to ${repoPath}`,
            });
          }
        }
      } catch {
        // skip
      }
    }
  }
  return findings;
}

function checkFrontmatter(): Finding[] {
  const findings: Finding[] = [];
  if (!existsSync(REPO_SKILLS)) return findings;

  for (const entry of readdirSync(REPO_SKILLS)) {
    const skillMd = join(REPO_SKILLS, entry, "SKILL.md");
    if (!existsSync(skillMd)) {
      findings.push({
        type: "missing-frontmatter",
        skill: entry,
        location: REPO_SKILLS,
        detail: "Missing SKILL.md entirely",
      });
      continue;
    }

    const content = readFileSync(skillMd, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch || !fmMatch[1]) {
      findings.push({
        type: "missing-frontmatter",
        skill: entry,
        location: skillMd,
        detail: "No YAML frontmatter block",
      });
      continue;
    }

    const fm: string = fmMatch[1];
    if (!fm.includes("name:")) {
      findings.push({
        type: "missing-frontmatter",
        skill: entry,
        location: skillMd,
        detail: 'Missing "name" in frontmatter',
      });
    }
    if (!fm.includes("description:")) {
      findings.push({
        type: "missing-frontmatter",
        skill: entry,
        location: skillMd,
        detail: 'Missing "description" in frontmatter',
      });
    }
  }
  return findings;
}

function checkStalePatterns(): Finding[] {
  const findings: Finding[] = [];
  if (!existsSync(REPO_SKILLS)) return findings;

  for (const entry of readdirSync(REPO_SKILLS)) {
    const skillMd = join(REPO_SKILLS, entry, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    const content = readFileSync(skillMd, "utf-8");
    for (const { pattern, label, note } of STALE_PATTERNS) {
      if (pattern.test(content)) {
        // Check it's not just mentioning migration FROM this thing
        const lines = content.split("\n");
        const matchingLines = lines.filter((l) => pattern.test(l));
        const isMigrationNote = matchingLines.every(
          (l) =>
            /migrat|replac|former|was|previously|legacy|old/i.test(l)
        );
        if (!isMigrationNote) {
          findings.push({
            type: "stale-pattern",
            skill: entry,
            location: skillMd,
            detail: `References "${label}" — ${note}`,
          });
        }
      }
    }
  }
  return findings;
}

function checkOrphans(): Finding[] {
  const findings: Finding[] = [];
  if (!existsSync(REPO_SKILLS)) return findings;

  const repoSkills = readdirSync(REPO_SKILLS).filter((e) => {
    const full = join(REPO_SKILLS, e);
    return existsSync(full) && lstatSync(full).isDirectory();
  });

  for (const skill of repoSkills) {
    const hasLink = HOME_SKILL_DIRS.some((dir) => {
      const linkPath = join(dir, skill);
      try {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          const target = realpathSync(linkPath);
          return target.startsWith(REPO_SKILLS);
        }
        return stat.isDirectory();
      } catch {
        return false;
      }
    });

    if (!hasLink) {
      findings.push({
        type: "orphan",
        skill,
        location: REPO_SKILLS,
        detail: `No symlink from any home skill dir`,
      });
    }
  }
  return findings;
}

async function llmDeepReview(): Promise<Finding[]> {
  const findings: Finding[] = [];
  if (!existsSync(AGENTS_MD) || !existsSync(REPO_SKILLS)) return findings;

  const agentsMd = readFileSync(AGENTS_MD, "utf-8");
  const skills = readdirSync(REPO_SKILLS).filter((e) =>
    existsSync(join(REPO_SKILLS, e, "SKILL.md"))
  );

  // Process in batches of 5 to avoid overwhelming inference
  for (let i = 0; i < skills.length; i += 5) {
    const batch = skills.slice(i, i + 5);
    const skillContents = batch.map((s) => {
      const content = readFileSync(join(REPO_SKILLS, s, "SKILL.md"), "utf-8");
      // Truncate to first 2000 chars to keep prompt reasonable
      return `### ${s}\n${content.slice(0, 2000)}`;
    });

    const prompt = `You are auditing agent skills for staleness. Compare these skills against the current system state (AGENTS.md below) and identify any that reference outdated architecture, removed services, wrong paths, incorrect versions, or missing capabilities.

CURRENT SYSTEM STATE:
${agentsMd.slice(0, 4000)}

SKILLS TO AUDIT:
${skillContents.join("\n\n---\n\n")}

For each skill with issues, respond with EXACTLY this format (one per line):
STALE|<skill-name>|<specific issue>

If a skill is current, do NOT include it. Only flag actual problems.`;

    try {
      const result = await infer(prompt);
      const lines = result.text.split("\n").filter((l: string) => l.startsWith("STALE|"));
      for (const line of lines) {
        const [, skill, detail] = line.split("|", 3);
        if (skill && detail) {
          findings.push({
            type: "llm-staleness",
            skill: skill.trim(),
            location: join(REPO_SKILLS, skill.trim(), "SKILL.md"),
            detail: detail.trim(),
          });
        }
      }
    } catch (err) {
      // LLM inference failure is non-fatal
      console.error(`[skill-garden] LLM batch review failed:`, err);
    }
  }

  return findings;
}

export const skillGarden = inngest.createFunction(
  {
    id: "skill-garden",
    name: "Skill Garden — Automated Skill Health Check",
    retries: 1,
  },
  [
    { cron: "0 6 * * *" }, // Daily at 6am PT
    { event: "skill-garden/check" }, // On-demand
  ],
  async ({ step, event }) => {
    const isDeepReview =
      event?.data?.deep === true ||
      new Date().getDate() === 1; // 1st of month

    // Step 1: Structural checks (fast, no LLM)
    const structural = await step.run("structural-checks", () => {
      const broken = checkBrokenSymlinks();
      const nonCanonical = checkNonCanonical();
      const frontmatter = checkFrontmatter();
      const stale = checkStalePatterns();
      const orphans = checkOrphans();

      return {
        broken,
        nonCanonical,
        frontmatter,
        stale,
        orphans,
        total:
          broken.length +
          nonCanonical.length +
          frontmatter.length +
          stale.length +
          orphans.length,
      };
    });

    // Step 2: LLM deep review (monthly or on-demand)
    let llmFindings: Finding[] = [];
    if (isDeepReview) {
      llmFindings = await step.run("llm-deep-review", async () => {
        return await llmDeepReview();
      });
    }

    // Step 3: Emit OTEL + notify if findings
    const allFindings = [
      ...structural.broken,
      ...structural.nonCanonical,
      ...structural.frontmatter,
      ...structural.stale,
      ...structural.orphans,
      ...llmFindings,
    ];

    const report = await step.run("report", () => {
      const summary = {
        timestamp: new Date().toISOString(),
        isDeepReview,
        findings: {
          total: allFindings.length,
          brokenSymlinks: structural.broken.length,
          nonCanonical: structural.nonCanonical.length,
          missingFrontmatter: structural.frontmatter.length,
          stalePatterns: structural.stale.length,
          orphans: structural.orphans.length,
          llmStaleness: llmFindings.length,
        },
        details: allFindings,
      };

      return summary;
    });

    // Step 4: Gateway notification if issues found
    if (allFindings.length > 0) {
      await step.run("notify", () => {
        const byType = allFindings.reduce(
          (acc, f) => {
            acc[f.type] = (acc[f.type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        const typeStr = Object.entries(byType)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ");

        const topIssues = allFindings
          .slice(0, 5)
          .map((f) => `• ${f.skill}: ${f.detail}`)
          .join("\n");

        const message = `🌿 Skill Garden: ${allFindings.length} issue${allFindings.length === 1 ? "" : "s"} found\n\n${typeStr}\n\n${topIssues}${allFindings.length > 5 ? `\n\n... and ${allFindings.length - 5} more. Run \`joelclaw skills audit\` for full report.` : ""}`;

        // Log to stdout for OTEL pickup
        console.log(
          JSON.stringify({
            event: "skill-garden.findings",
            findings: report.findings,
            message,
          })
        );

        return { message, notified: true };
      });
    }

    return report;
  }
);
