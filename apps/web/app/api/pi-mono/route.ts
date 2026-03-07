import { cacheLife } from "next/cache";
import { NextResponse } from "next/server";

const PROTOCOL_VERSION = 1 as const;
const SERVICE = "pi-mono-corpus";
const VERSION = "0.1.0";
const ORIGIN = "https://joelclaw.com";
const DISTRIBUTION_REPO = "https://github.com/joelhooks/contributing-to-pi-mono";

async function getPayload() {
  "use cache";
  cacheLife("hours");

  return {
    ok: true,
    command: "GET /api/pi-mono",
    protocolVersion: PROTOCOL_VERSION,
    result: {
      service: SERVICE,
      repo: "https://github.com/badlogic/pi-mono",
      description:
        "Public discovery endpoint for the joelclaw pi-mono corpus: docs, issues, issue comments, pull requests, review comments, commits, releases, and evidence-backed maintainer heuristics.",
      search: {
        endpoint: `${ORIGIN}/api/search`,
        collection: "pi_mono_artifacts",
        rateLimit: "Inherited from /api/search (Upstash sliding window)",
        examples: [
          `${ORIGIN}/api/search?q=which+provider%2Fmodel+triggered+this&collection=pi_mono_artifacts`,
          `${ORIGIN}/api/search?q=Breaks+TUI&collection=pi_mono_artifacts`,
          `${ORIGIN}/api/search?q=getAgentDir&collection=pi_mono_artifacts`,
        ],
      },
      corpus: {
        kinds: [
          "repo_doc",
          "issue",
          "issue_comment",
          "pull_request",
          "pull_request_review_comment",
          "commit",
          "release",
          "maintainer_profile",
          "sync_state",
        ],
        intendedUse: [
          "Draft higher-signal issues and PRs against pi-mono",
          "Study maintainer review language before proposing changes",
          "Compare accepted and rejected contribution patterns",
        ],
      },
      install: {
        skill: {
          status: "available",
          repo: DISTRIBUTION_REPO,
          path: "skills/contributing-to-pi-mono/SKILL.md",
          steps: [
            `git clone ${DISTRIBUTION_REPO} ~/Code/joelhooks/contributing-to-pi-mono`,
            "mkdir -p ~/.pi/agent/skills",
            "ln -sfn ~/Code/joelhooks/contributing-to-pi-mono/skills/contributing-to-pi-mono ~/.pi/agent/skills/contributing-to-pi-mono",
            "Restart pi or start a new session so the skill inventory refreshes",
          ],
        },
        extension: {
          status: "available",
          repo: DISTRIBUTION_REPO,
          path: "extensions/pi-mono-search/index.ts",
          steps: [
            `git clone ${DISTRIBUTION_REPO} ~/Code/joelhooks/contributing-to-pi-mono`,
            "cd ~/Code/joelhooks/contributing-to-pi-mono && npm install",
            "mkdir -p ~/.pi/agent/extensions",
            "ln -sfn ~/Code/joelhooks/contributing-to-pi-mono ~/.pi/agent/extensions/contributing-to-pi-mono",
            "Start a fresh pi session so the extension loader picks it up",
          ],
        },
      },
    },
    nextActions: [
      {
        command: `curl -sS \"${ORIGIN}/api/search?q=which+provider%2Fmodel+triggered+this&collection=pi_mono_artifacts\"`,
        description: "Search for the maintainer's reproduction-demand pattern",
      },
      {
        command: `curl -sS \"${ORIGIN}/api/search?q=extension&collection=pi_mono_artifacts\"`,
        description: "Search for extension-vs-core guidance",
      },
      {
        command: `curl -sS \"${ORIGIN}/api/search?q=getAgentDir&collection=pi_mono_artifacts\"`,
        description: "Find a concrete accepted-direction example",
      },
      {
        command: `git clone ${DISTRIBUTION_REPO} ~/Code/joelhooks/contributing-to-pi-mono`,
        description: "Clone the public extension + skill repo",
      },
    ],
    meta: {
      service: SERVICE,
      version: VERSION,
      cached: true,
    },
  };
}

export async function GET() {
  const payload = await getPayload();
  return NextResponse.json(payload);
}
