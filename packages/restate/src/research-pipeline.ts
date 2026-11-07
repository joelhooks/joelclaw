import type { DagNodeInput } from "./workflows/dag-orchestrator";

export type ResearchSearchProvider = "duckduckgo" | "parallel" | "none";

export function parseResearchSearchProvider(args: string[]): ResearchSearchProvider {
  const index = args.indexOf("--search-provider");
  if (index !== args.lastIndexOf("--search-provider")) {
    throw new Error("Specify --search-provider only once");
  }
  const value = index === -1 ? "duckduckgo" : args[index + 1];
  if (value !== "duckduckgo" && value !== "parallel" && value !== "none") {
    throw new Error("--search-provider requires duckduckgo, parallel, or none");
  }
  return value;
}

function buildResearchSearchNode(
  researchTopic: string,
  provider: ResearchSearchProvider,
): DagNodeInput {
  if (provider === "parallel") {
    return {
      id: "web-search",
      task: "search the web for research sources",
      handler: "parallel",
      config: { objective: researchTopic, search_queries: [researchTopic] },
    };
  }
  if (provider === "none") {
    return {
      id: "web-search",
      task: "Web search disabled; synthesize only the other supplied sources.",
      handler: "noop",
    };
  }
  if (provider !== "duckduckgo") throw new Error("Unknown research search provider");
  return {
    id: "web-search",
    task: `search the web for: ${researchTopic}`,
    handler: "shell",
    config: {
      command: `curl -sS "https://api.duckduckgo.com/?q=${encodeURIComponent(researchTopic)}&format=json&no_html=1" | jq -r '.AbstractText // .RelatedTopics[:5][] .Text // "no results"' 2>/dev/null | head -50`,
    },
  };
}

export function buildResearchPipeline(
  researchTopic: string,
  searchProvider: ResearchSearchProvider = "duckduckgo",
): DagNodeInput[] {
  return [
    buildResearchSearchNode(researchTopic, searchProvider),
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
      task: "search optional agent memory",
      handler: "recall",
      config: {
        query: researchTopic.slice(0, 1_000),
        scope: { project: "joelclaw-fleet", workstream: "default" },
        access: {
          principalRef: "service:restate-research",
          purpose: "research-pipeline",
          allowedPrivacy: ["public", "private"],
        },
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
