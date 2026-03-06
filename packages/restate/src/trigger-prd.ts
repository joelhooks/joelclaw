import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PrdExecutionPlan, PrdStoryPlan } from "./prd-types";
import type { DagNodeInput } from "./workflows/dag-orchestrator";

const RESTATE_INGRESS = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";
const PRD_PLANNER_MODEL = process.env.PRD_PLANNER_MODEL ?? "gpt-5.4";
const PRD_EXEC_AGENT = process.env.PRD_EXEC_AGENT ?? "story-executor";
const PRD_EXEC_MODEL = process.env.PRD_EXEC_MODEL?.trim() || undefined;
const PRD_AGENT_WORKER_URL = process.env.PRD_AGENT_WORKER_URL ?? "http://127.0.0.1:3111";
const PI_PATH_DIRS = [
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/.bun/bin`,
  `${process.env.HOME}/.local/share/fnm/aliases/default/bin`,
];
const DEFAULT_TIMEOUT_SECONDS = 60 * 60;
const MAX_TIMEOUT_MS = 60 * 60_000;

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const prdPathArg = getArg("--prd");
const planPathArg = getArg("--plan");
const workflowId = getArg("--id") ?? `prd-${Date.now().toString(36)}`;
const cwd = resolve(getArg("--cwd") ?? `${process.env.HOME}/Code/joelhooks/joelclaw`);
const asyncMode = !args.includes("--sync");

if (!prdPathArg && !planPathArg) {
  console.error("❌ --prd <path> or --plan <path> is required");
  process.exit(1);
}

const prdPath = prdPathArg ? resolve(prdPathArg) : undefined;
const planPath = planPathArg ? resolve(planPathArg) : undefined;

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readEnvValue(name: string): Promise<string | undefined> {
  const direct = process.env[name]?.trim();
  if (direct) return direct;

  const envPath = join(process.env.HOME ?? "/Users/joel", ".config", "system-bus.env");
  try {
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key === name) return value.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function compilePrdPlan(prdContent: string, sourcePrdPath: string): Promise<PrdExecutionPlan> {
  const prompt = [
    "Compile this PRD into a safe execution DAG for coding agents.",
    "Return JSON only.",
    "Maximize parallelism where there is no file overlap.",
    "Stories in the same wave MUST NOT overlap files.",
    "Each story must be small enough for a single agent run.",
    "Do not include coordination instructions; they are prepended later.",
    "Use exact file paths when inferable from the PRD.",
    "Prefer 3-8 implementation stories.",
    "Output schema:",
    JSON.stringify({
      summary: "one-line summary",
      waves: [
        {
          id: "wave-0",
          stories: [
            {
              id: "story-1",
              title: "short title",
              summary: "what changes",
              prompt: "implementation prompt body only",
              files: ["packages/example/src/file.ts"],
              dependsOn: [],
              timeoutSeconds: 3600,
              sandbox: "workspace-write",
            },
          ],
        },
      ],
    }, null, 2),
    "",
    `Repo cwd: ${cwd}`,
    `PRD path: ${sourcePrdPath}`,
    "",
    "PRD markdown:",
    prdContent,
  ].join("\n");

  const dir = await mkdtemp(join(tmpdir(), "prd-plan-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, prompt, "utf8");

  try {
    const args = [
      "pi",
      "-p",
      "--no-session",
      "--no-extensions",
      "--models",
      PRD_PLANNER_MODEL,
      "--system-prompt",
      "You compile PRDs into safe execution DAGs. Output JSON only.",
    ];

    const proc = Bun.spawn(args, {
      stdin: Bun.file(promptPath),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: [...PI_PATH_DIRS, process.env.PATH].filter(Boolean).join(":"),
      },
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`pi exited ${exitCode}: ${stderr.slice(0, 1000)}`);
    }

    let text = stdout.trim();
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.text) text = String(parsed.text).trim();
    } catch {
      // raw stdout
    }

    const normalized = text.replace(/^```json\s*/u, "").replace(/^```/u, "").replace(/```$/u, "").trim();
    const plan = JSON.parse(normalized) as PrdExecutionPlan;
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.waves)) {
      throw new Error("compiled PRD plan is missing waves[]");
    }
    return plan;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadPlanFromFile(path: string): Promise<PrdExecutionPlan> {
  const raw = await readFile(path, "utf8");
  const plan = JSON.parse(raw) as PrdExecutionPlan;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.waves)) {
    throw new Error(`plan file ${path} is missing waves[]`);
  }
  return plan;
}

function withCoordinationContract(story: PrdStoryPlan): string {
  const files = Array.isArray(story.files) && story.files.length > 0
    ? story.files.join(", ")
    : "infer exact paths before editing and reserve them";

  return [
    "You are executing one joelclaw PRD story inside a Restate-orchestrated run.",
    "Mandatory coordination contract:",
    "- Use joelclaw mail / mail_* wrappers for coordination.",
    "- Send a Starting: update before work, at least one Status: update during work, and a Done: handoff at the end.",
    "- Reserve exact file paths before editing and release them after commit/handoff.",
    "- Include touched file paths in status and done messages.",
    "- Work only inside the reserved file set plus directly adjacent tests/docs required by the story.",
    "- Before committing, run `git status --short` and verify every changed path is in scope.",
    "- If unrelated dirty paths exist, do not scoop them into the commit; report the conflict and fail closed.",
    "- Commit atomically with a prompt-style commit message.",
    `- Preferred files for this story: ${files}`,
    `- Working directory: ${cwd}`,
    "",
    `Story: ${story.title}`,
    story.summary,
    "",
    story.prompt.trim(),
  ].join("\n");
}

function buildAgentStoryNode(
  story: PrdStoryPlan,
  token: string | undefined,
  inheritedDependsOn: string[]
): DagNodeInput {
  const requestId = `${workflowId}-${story.id}-${randomUUID().slice(0, 8)}`;
  const timeoutSeconds = Number.isFinite(story.timeoutSeconds)
    ? Math.max(300, Math.min(story.timeoutSeconds!, DEFAULT_TIMEOUT_SECONDS))
    : DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = Math.max(5_000, Math.min(timeoutSeconds * 1000, MAX_TIMEOUT_MS));
  const payload = {
    requestId,
    task: withCoordinationContract(story),
    tool: "pi",
    agent: PRD_EXEC_AGENT,
    cwd,
    timeout: timeoutSeconds,
    ...(PRD_EXEC_MODEL ? { model: PRD_EXEC_MODEL } : {}),
    sandbox: story.sandbox ?? "workspace-write",
    readFiles: true,
  };

  const dispatchUrl = `${PRD_AGENT_WORKER_URL}/internal/agent-dispatch`;
  const resultUrl = `${PRD_AGENT_WORKER_URL}/internal/agent-result/${requestId}`;
  const authHeader = token ? ` -H 'x-otel-emit-token: ${token}'` : "";
  const pollScript = [
    `deadline=$(( $(date +%s) + ${Math.ceil(timeoutMs / 1000)} ))`,
    `while [ $(date +%s) -lt $deadline ]; do`,
    `  response=$(curl -fsS${authHeader} ${shellEscape(resultUrl)}) || exit 1`,
    `  status=$(printf '%s' "$response" | python -c 'import json,sys; print(json.load(sys.stdin).get("status", ""))')`,
    `  if [ "$status" = "completed" ]; then printf '%s\\n' "$response"; exit 0; fi`,
    `  if [ "$status" = "failed" ]; then printf '%s\\n' "$response" >&2; exit 1; fi`,
    `  sleep 5`,
    `done`,
    `response=$(curl -fsS${authHeader} ${shellEscape(resultUrl)}) || exit 1`,
    `status=$(printf '%s' "$response" | python -c 'import json,sys; print(json.load(sys.stdin).get("status", ""))')`,
    `if [ "$status" = "completed" ]; then printf '%s\\n' "$response"; exit 0; fi`,
    `if [ "$status" = "failed" ]; then printf '%s\\n' "$response" >&2; exit 1; fi`,
    `echo '{"ok":false,"status":"timeout","requestId":"${requestId}"}' >&2`,
    `exit 1`,
  ].join("\n");
  const command = [
    `curl -fsS -X POST ${shellEscape(dispatchUrl)}`,
    `  -H 'Content-Type: application/json'`,
    authHeader ? authHeader.trimStart() : undefined,
    `  --data ${shellEscape(JSON.stringify(payload))}`,
    `&& bash -lc ${shellEscape(pollScript)}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" \\\n");

  return {
    id: story.id,
    task: story.title,
    dependsOn: Array.from(new Set([...(story.dependsOn ?? []), ...inheritedDependsOn])).sort(),
    handler: "shell",
    config: {
      command,
      timeoutMs,
    },
  };
}

function buildDagNodes(plan: PrdExecutionPlan, token: string | undefined): DagNodeInput[] {
  const nodes: DagNodeInput[] = [];
  const priorWaveIds: string[] = [];

  for (const wave of plan.waves) {
    const waveIds: string[] = [];
    for (const story of wave.stories ?? []) {
      nodes.push(buildAgentStoryNode(story, token, priorWaveIds));
      waveIds.push(story.id);
    }
    priorWaveIds.push(...waveIds);
  }

  return nodes;
}

const internalToken = await readEnvValue("OTEL_EMIT_TOKEN");

let plan: PrdExecutionPlan;
let planSourceLabel: string;
if (planPath) {
  console.log(`📦 Loading PRD execution plan from ${planPath}`);
  console.log(`   cwd: ${cwd}`);
  plan = await loadPlanFromFile(planPath);
  planSourceLabel = planPath;
} else {
  const prdContent = await readFile(prdPath!, "utf8");
  console.log(`🧠 Compiling PRD with ${PRD_PLANNER_MODEL}`);
  console.log(`   prd: ${prdPath}`);
  console.log(`   cwd: ${cwd}`);
  plan = await compilePrdPlan(prdContent, prdPath!);
  planSourceLabel = prdPath!;
}

const nodes = buildDagNodes(plan, internalToken);
const request = {
  requestId: workflowId,
  pipeline: `prd:${planSourceLabel.split("/").at(-1) ?? "unknown"}`,
  nodes,
};

console.log(`🧠 Prepared PRD execution plan`);
console.log(`   workflowId: ${workflowId}`);
console.log(`   source: ${planSourceLabel}`);
console.log(`   summary: ${plan.summary}`);
console.log(`   waves: ${plan.waves.length}`);
console.log(`   nodes: ${nodes.length}`);
console.log(`   worker bridge: ${PRD_AGENT_WORKER_URL}`);
console.log(`   bridge auth: ${internalToken ? "OTEL_EMIT_TOKEN" : "none"}`);
console.log(`   agent tool: pi`);
console.log(`   agent role: ${PRD_EXEC_AGENT}`);
console.log(`   agent model override: ${PRD_EXEC_MODEL ?? "from agent role"}`);
console.log("");

const endpoint = asyncMode
  ? `${RESTATE_INGRESS}/dagOrchestrator/${workflowId}/run/send`
  : `${RESTATE_INGRESS}/dagOrchestrator/${workflowId}/run`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(request),
});

if (!response.ok) {
  const error = await response.text();
  console.error(`❌ ${response.status}: ${error}`);
  process.exit(1);
}

const result = await response.json();

if (asyncMode) {
  console.log("🚀 PRD DAG submitted");
  console.log(`   invocationId: ${result.invocationId ?? result.id ?? "pending"}`);
  console.log(`   check: curl ${RESTATE_INGRESS}/dagOrchestrator/${workflowId}/output`);
  console.log(`   otel:  joelclaw otel search \"dag.workflow\" --hours 1`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
