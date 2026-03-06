/**
 * Trigger a DAG workload through Restate.
 *
 * Usage:
 *   bun run dag                                              # demo pipeline (noop)
 *   bun run dag -- --pipeline health                         # system health check
 *   bun run dag -- --pipeline research --topic "Restate"     # multi-source research
 *   bun run dag -- --pipeline enrich-contact --name "Alex Hillman"
 *   bun run dag -- --pipeline enrich-contact --name "John Lindquist" --github joelhooks --depth quick
 *   bun run dag -- --id my-run-1
 */

import { buildHealthPipeline } from "./pipelines";
import type { DagNodeInput } from "./workflows/dag-orchestrator";

const RESTATE_INGRESS =
  process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const pipeline = getArg("--pipeline") ?? "demo";
const workflowId = getArg("--id") ?? `dag-${Date.now().toString(36)}`;
const sleepMs = Number.parseInt(getArg("--sleep-ms") ?? "500", 10);
const topic = getArg("--topic") ?? "Restate durable execution";
const contactName = getArg("--name") ?? "";
const contactDepth = (getArg("--depth") ?? "full") as "quick" | "full";
const githubHint = getArg("--github");
const twitterHint = getArg("--twitter");
const emailHint = getArg("--email");
const websiteHint = getArg("--website");
const asyncMode = args.includes("--async");

const nodeDelay = Number.isFinite(sleepMs)
  ? Math.max(0, Math.min(sleepMs, 5_000))
  : 500;

// ━━━ Pipeline definitions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function demoPipeline(): DagNodeInput[] {
  return [
    { id: "discover", task: "discover source inputs", simulatedMs: nodeDelay },
    { id: "analyze", task: "analyze source inputs", simulatedMs: nodeDelay },
    {
      id: "synthesize",
      task: "synthesize outputs",
      dependsOn: ["discover", "analyze"],
      simulatedMs: nodeDelay,
    },
    {
      id: "publish",
      task: "publish final artifact",
      dependsOn: ["synthesize"],
      simulatedMs: nodeDelay,
    },
  ];
}

function healthPipeline(): DagNodeInput[] {
  return buildHealthPipeline();
}

function researchPipeline(researchTopic: string): DagNodeInput[] {
  return [
    {
      id: "web-search",
      task: `search the web for: ${researchTopic}`,
      handler: "shell",
      config: {
        command: `curl -sS "https://api.duckduckgo.com/?q=${encodeURIComponent(researchTopic)}&format=json&no_html=1" | jq -r '.AbstractText // .RelatedTopics[:5][] .Text // "no results"' 2>/dev/null | head -50`,
      },
    },
    {
      id: "vault-search",
      task: `search local vault for: ${researchTopic}`,
      handler: "shell",
      config: {
        command: `grep -ril "${researchTopic.replace(/"/g, '\\"').slice(0, 60)}" ~/Vault/docs/decisions/ 2>/dev/null | head -10 | while read f; do echo "--- $f ---"; head -30 "$f"; echo; done || echo "no vault matches"`,
      },
    },
    {
      id: "memory-recall",
      task: `search agent memory for: ${researchTopic}`,
      handler: "shell",
      config: {
        command: `joelclaw recall "${researchTopic.replace(/"/g, '\\"').slice(0, 80)}" 2>/dev/null | head -40 || echo "recall unavailable"`,
      },
    },
    {
      id: "synthesize",
      task: "synthesize research findings",
      handler: "infer",
      dependsOn: ["web-search", "vault-search", "memory-recall"],
      config: {
        prompt: [
          `Research topic: ${researchTopic}`,
          "",
          "Synthesize these sources into a brief research memo.",
          "Cite which source each finding came from.",
          "",
          "## Web search results",
          "{{web-search}}",
          "",
          "## Vault/ADR matches",
          "{{vault-search}}",
          "",
          "## Agent memory",
          "{{memory-recall}}",
        ].join("\n"),
        system:
          "You are a research analyst. Produce a structured memo: key findings, source attribution, gaps, and recommended next steps. Under 300 words.",
      },
    },
  ];
}

// ━━━ Contact Enrichment Pipeline (ADR-0133) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CONTACT_SYNTH_SYSTEM = `You maintain Vault contact dossiers.
Return ONLY markdown with YAML frontmatter and no code fences.

Required output format:
---
name: <full name>
aliases: [<optional aliases>]
role: <best current role summary>
organizations: [<orgs>]
vip: <true|false>
slack_user_id: <optional>
github: <optional>
twitter: <optional>
email: <optional>
website: <optional>
tags: [<tags>]
---

# <Name>
## Contact Channels
- include discovered channels/handles

## Projects
- summarize relevant projects

## Key Context
- concise relationship and working context

## Recent Activity
- bullet timeline in YYYY-MM-DD format when possible

Rules:
- Merge with existing file when present.
- Keep factual claims grounded in provided evidence; do not invent.
- If uncertain, mark as "Unverified".
- Preserve useful existing facts unless contradicted by newer evidence.`;

const ROAM_ARCHIVE =
  process.env.ROAM_ARCHIVE_PATH ??
  `${process.env.HOME}/Code/joelhooks/egghead-roam-research/egghead-2026-01-19-13-09-38.edn`;

const TYPESENSE_FALLBACK_KEY =
  "391a65d92ff0b1d63af0e0d6cca04fdff292b765d833a65a25fb928b8a0fb065";

function shellSafe(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function enrichContactPipeline(
  name: string,
  depth: "quick" | "full",
  hints: { github?: string; twitter?: string; email?: string; website?: string },
): DagNodeInput[] {
  const safe = shellSafe(name);
  const nodes: DagNodeInput[] = [];

  // --- Wave 0: parallel source probes ---

  nodes.push({
    id: "vault-existing",
    task: `load existing contact file for ${name}`,
    handler: "shell",
    config: {
      command: `cat ~/Vault/Contacts/'${safe}'.md 2>/dev/null || echo '(no existing contact file)'`,
    },
  });

  nodes.push({
    id: "memory-recall",
    task: `search agent memory for ${name}`,
    handler: "shell",
    config: {
      command: `joelclaw recall '${safe}' 2>/dev/null | head -80 || echo 'recall unavailable'`,
    },
  });

  nodes.push({
    id: "typesense-search",
    task: `search indexed content for ${name}`,
    handler: "shell",
    config: {
      command: [
        `API_KEY=$(secrets lease typesense_api_key --ttl 5m 2>/dev/null || echo '${TYPESENSE_FALLBACK_KEY}')`,
        `curl -sS --max-time 10 "http://localhost:8108/multi_search" \\`,
        `  -H "X-TYPESENSE-API-KEY: $API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"searches":[`,
        `    {"collection":"vault_notes","q":"${safe}","query_by":"title,content","per_page":"8"},`,
        `    {"collection":"slack_messages","q":"${safe}","query_by":"text,user_name","per_page":"8"}`,
        `  ]}' 2>/dev/null | jq '.results[]? | {collection: .request_params.collection_name, found: .found, hits: [.hits[]?.document | {title, path, text: ((.text // .content // "")[:200])}]}' 2>/dev/null || echo 'typesense unavailable'`,
      ].join("\n"),
    },
  });

  if (depth === "full") {
    nodes.push({
      id: "roam-search",
      task: `search Roam archive for ${name}`,
      handler: "shell",
      config: {
        command: [
          `python3 -c '`,
          `import json, re, sys`,
          `path, query = sys.argv[1], sys.argv[2].lower()`,
          `matches = []`,
          `with open(path, errors="ignore") as f:`,
          `    for i, line in enumerate(f, 1):`,
          `        if query in line.lower():`,
          `            matches.append({"line": i, "text": line.strip()[:200]})`,
          `            if len(matches) >= 20: break`,
          `print(json.dumps({"matches": matches, "count": len(matches)}))`,
          `' '${ROAM_ARCHIVE}' '${safe}' 2>/dev/null || echo 'roam search unavailable'`,
        ].join("\n"),
      },
    });

    nodes.push({
      id: "granola-search",
      task: `search Granola meetings for ${name}`,
      handler: "shell",
      config: {
        command: `granola search '${safe}' 2>/dev/null | head -50 || echo 'granola unavailable'`,
      },
    });

    nodes.push({
      id: "slack-search",
      task: `search egghead Slack for ${name}`,
      handler: "shell",
      config: {
        command: [
          `TOKEN=$(secrets lease slack_user_token --ttl 5m 2>/dev/null || echo '')`,
          `[ -z "$TOKEN" ] && echo '{"error":"no_slack_token"}' && exit 0`,
          `curl -sS --max-time 15 "https://slack.com/api/users.list?limit=200" -H "Authorization: Bearer $TOKEN" | \\`,
          `  jq '[.members[]? | select(.deleted != true and .is_bot != true) | select((.real_name // .name // "") | test("${safe}"; "i")) | {id, name: .real_name, display_name: .profile.display_name, email: .profile.email}] | .[:3]' 2>/dev/null || echo '{"error":"slack_api_failed"}'`,
        ].join("\n"),
      },
    });

    if (hints.github) {
      nodes.push({
        id: "github-profile",
        task: `fetch GitHub profile for ${hints.github}`,
        handler: "http",
        config: {
          url: `https://api.github.com/users/${encodeURIComponent(hints.github)}`,
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "joelclaw-contact-enrich",
          },
        },
      });
    }

    if (hints.website) {
      nodes.push({
        id: "website-fetch",
        task: `fetch website for ${hints.website}`,
        handler: "http",
        config: { url: hints.website },
      });
    }
  }

  // --- Wave 1: synthesis ---

  const sourceIds = nodes.map((n) => n.id);

  // Build synthesis prompt referencing all source node IDs
  const sourceBlocks = sourceIds
    .map((id) => `## ${id}\n{{${id}}}`)
    .join("\n\n");

  const hintsBlock = Object.entries(hints)
    .filter(([, v]) => v)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  nodes.push({
    id: "synthesize",
    task: `synthesize contact dossier for ${name}`,
    handler: "infer",
    dependsOn: sourceIds,
    config: {
      system: CONTACT_SYNTH_SYSTEM,
      prompt: [
        `Contact name: ${name}`,
        `Enrichment depth: ${depth}`,
        hintsBlock ? `Known hints:\n${hintsBlock}` : "",
        "",
        "Source data follows. Some sources may have returned errors — skip those.",
        "",
        sourceBlocks,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  });

  // --- Wave 2: write + notify + otel ---

  nodes.push({
    id: "write-vault",
    task: `write contact dossier to Vault`,
    handler: "shell",
    dependsOn: ["synthesize"],
    config: {
      // $DEP_synthesize env var avoids shell escaping issues with markdown content
      command: [
        `mkdir -p ~/Vault/Contacts`,
        `printf '%s\\n' "$DEP_synthesize" > ~/Vault/Contacts/'${safe}'.md`,
        `BYTES=$(wc -c < ~/Vault/Contacts/'${safe}'.md | tr -d ' ')`,
        `echo "wrote $BYTES bytes to ~/Vault/Contacts/${safe}.md"`,
      ].join(" && "),
    },
  });

  nodes.push({
    id: "notify",
    task: `notify Joel about enrichment result`,
    handler: "shell",
    dependsOn: ["write-vault"],
    config: {
      command: `joelclaw notify send "✅ Contact enrichment complete for ${safe}. Dossier at ~/Vault/Contacts/${safe}.md" 2>/dev/null || echo 'notify: delivery attempted'`,
    },
  });

  nodes.push({
    id: "otel-enrich-complete",
    task: "emit contact enrichment OTEL summary",
    handler: "shell",
    dependsOn: ["write-vault"],
    config: {
      command: `joelclaw otel emit "contact.enrich.completed" --source restate --component contact-enrich --success true 2>/dev/null || echo 'otel emit done'`,
    },
  });

  return nodes;
}

// ━━━ Select pipeline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let nodes: DagNodeInput[];
let pipelineName = pipeline;

switch (pipeline) {
  case "health":
    nodes = healthPipeline();
    break;
  case "research":
    nodes = researchPipeline(topic);
    break;
  case "enrich-contact": {
    if (!contactName) {
      console.error("❌ --name is required for enrich-contact pipeline");
      process.exit(1);
    }
    nodes = enrichContactPipeline(contactName, contactDepth, {
      github: githubHint,
      twitter: twitterHint,
      email: emailHint,
      website: websiteHint,
    });
    pipelineName = `enrich-contact:${contactName}`;
    break;
  }
  case "demo":
  default:
    nodes = demoPipeline();
    break;
}

// ━━━ Send to Restate ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const request = { requestId: workflowId, pipeline: pipelineName, nodes };

console.log(`🕸️  Triggering DAG workload — ${workflowId}`);
console.log(`   Pipeline: ${pipelineName}`);
console.log(`   Restate: ${RESTATE_INGRESS}`);
console.log(`   Mode: ${asyncMode ? "async (fire-and-forget → gateway notification)" : "sync (wait for result)"}`);
console.log(
  `   Nodes: ${nodes.map((n) => `${n.id}(${n.handler ?? "noop"})`).join(", ")}`,
);
console.log(``);

if (asyncMode) {
  // Fire-and-forget: use Restate's /send endpoint, returns invocation ID immediately
  const response = await fetch(
    `${RESTATE_INGRESS}/dagOrchestrator/${workflowId}/run/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ ${response.status}: ${error}`);
    process.exit(1);
  }

  const sendResult = await response.json();
  console.log(`🚀 DAG submitted (async):`);
  console.log(`   workflowId: ${workflowId}`);
  console.log(`   invocationId: ${sendResult.invocationId ?? sendResult.id ?? "pending"}`);
  console.log(`   status: ${sendResult.status ?? "Accepted"}`);
  console.log(``);
  console.log(`   Results will be pushed to gateway when complete.`);
  console.log(`   Check OTEL:  joelclaw otel search "dag.workflow" --hours 1`);
  console.log(`   Check state: curl ${RESTATE_INGRESS}/dagOrchestrator/${workflowId}/output`);
} else {
  // Synchronous: wait for full result
  const response = await fetch(
    `${RESTATE_INGRESS}/dagOrchestrator/${workflowId}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ ${response.status}: ${error}`);
    process.exit(1);
  }

  const result = await response.json();

  console.log(`✅ DAG run complete:`);
  console.log(`   workflowId: ${result.workflowId}`);
  console.log(`   pipeline: ${result.pipeline}`);
  console.log(`   nodeCount: ${result.nodeCount}`);
  console.log(`   waveCount: ${result.waveCount}`);
  console.log(`   duration: ${result.durationMs}ms`);
  console.log(
    `   completionOrder: ${(result.completionOrder ?? []).join(" → ")}`,
  );
  console.log(``);

  // For real pipelines, print the synthesizer output nicely
  const lastSynthWave = result.waves?.find((w: { results: Array<{ handler: string }> }) =>
    w.results?.some((r: { handler: string }) => r.handler === "infer"),
  );
  const synthResult = lastSynthWave?.results?.find(
    (r: { handler: string }) => r.handler === "infer",
  );
  if (synthResult?.output) {
    console.log("━".repeat(60));
    console.log(synthResult.output);
    console.log("━".repeat(60));
  }

  console.log(`\nFull result:\n${JSON.stringify(result, null, 2)}`);
}
