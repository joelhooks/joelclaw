import { cacheLife } from "next/cache";
import { NextResponse } from "next/server";

const PROTOCOL_VERSION = 1 as const;
const SERVICE = "pi-mono-corpus";
const VERSION = "0.1.0";
const ORIGIN = "https://joelclaw.com";
const SKILL_REPO = "https://github.com/joelhooks/joelclaw";
const EXTENSION_REPO = "https://github.com/joelhooks/contributing-to-pi-mono";

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
          repo: SKILL_REPO,
          path: "skills/contributing-to-pi/SKILL.md",
          steps: [
            `git clone ${SKILL_REPO} ~/Code/joelhooks/joelclaw`,
            "mkdir -p ~/.pi/agent/skills",
            "ln -sfn ~/Code/joelhooks/joelclaw/skills/contributing-to-pi ~/.pi/agent/skills/contributing-to-pi",
            "Restart pi or start a new session so the skill inventory refreshes",
          ],
        },
        extension: {
          status: "planned",
          repo: EXTENSION_REPO,
          note:
            "The public extension repo does not exist yet. This endpoint will publish real install steps once `joelhooks/contributing-to-pi-mono` is created.",
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
