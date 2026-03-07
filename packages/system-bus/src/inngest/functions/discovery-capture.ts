import { $ } from "bun";
import { infer } from "../../lib/inference";
import { enqueueRegisteredQueueEvent, isQueuePilotEnabled } from "../../lib/queue";
import { emitMeasuredOtelEvent, emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { DISCOVERY_PROMPT } from "../prompts/discovery";

const VAULT_DISCOVERIES = `${process.env.HOME}/Vault/Resources/discoveries`;

type DiscoveryCapturedEventData = {
  vaultPath: string;
  topic: string;
  slug: string;
  url?: string;
  title?: string;
};

function shouldQueueDiscoveryCaptured(): boolean {
  return isQueuePilotEnabled("discovery-captured");
}

function buildDiscoveryCapturedEventData(input: DiscoveryCapturedEventData): DiscoveryCapturedEventData {
  const data: DiscoveryCapturedEventData = {
    vaultPath: input.vaultPath,
    topic: input.topic,
    slug: input.slug,
  };

  if (input.url?.trim()) {
    data.url = input.url.trim();
  }

  if (input.title?.trim()) {
    data.title = input.title.trim();
  }

  return data;
}

export const __discoveryCaptureTestUtils = {
  buildDiscoveryCapturedEventData,
  shouldQueueDiscoveryCaptured,
};

/**
 * Discovery Capture — investigates interesting finds and writes vault notes.
 *
 * Receives a URL and/or context. Does all the heavy lifting:
 * clone repos, extract articles, generate a compelling title,
 * decide tags/relevance, write vault note in Joel's voice, and slog.
 */
export const discoveryCapture = inngest.createFunction(
  {
    id: "discovery-capture",
    concurrency: { limit: 2 },
    retries: 1,
  },
  { event: "discovery/noted" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as import("../middleware/gateway").GatewayContext | undefined;
    const { url, context } = event.data;
    const today = new Date().toISOString().split("T")[0];

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "discovery-capture",
        action: "discovery.investigate.pipeline",
        metadata: {
          trigger: event.name,
          url: url ?? null,
        },
      },
      async () => {
        await step.run("otel-discovery-investigate-started", async () => {
          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "discovery-capture",
            action: "discovery.investigate.started",
            success: true,
            metadata: {
              url: url ?? null,
            },
          });
        });

        try {
          // Step 1: Gather raw material
          const material = await step.run("investigate", async () => {
            let content = "";
            let sourceType = "unknown";

            if (url?.includes("github.com")) {
              sourceType = "repo";
              const tmpDir = `/tmp/discovery-${Date.now()}`;
              try {
                await $`git clone --depth 1 ${url} ${tmpDir} 2>/dev/null`.quiet();
                const readmePath = `${tmpDir}/README.md`;
                if (await Bun.file(readmePath).exists()) {
                  const readme = await Bun.file(readmePath).text();
                  content = readme.length > 8000 ? readme.slice(0, 8000) + "\n\n[truncated]" : readme;
                }
                const tree = await $`find ${tmpDir} -maxdepth 2 -not -path '*/.*' -not -path '*/node_modules/*' | head -40`.text();
                content += `\n\n## File Structure\n\`\`\`\n${tree}\n\`\`\``;
              } catch {
                content = `Could not clone ${url}.`;
              } finally {
                await $`rm -rf ${tmpDir}`.quiet();
              }
            } else if (url) {
              sourceType = "article";
              try {
                content = (await $`defuddle ${url} 2>/dev/null`.text()).slice(0, 8000);
              } catch {
                content = `Could not extract content from ${url}.`;
              }
            } else {
              sourceType = "idea";
              content = context ?? "No content provided.";
            }

            return { content, sourceType };
          });

          // Step 2: Let pi do everything — title, tags, analysis, vault note
          const result = await step.run("generate-note", async () => {
            const prompt = DISCOVERY_PROMPT({
              url: url ?? undefined,
              context: context ?? undefined,
              sourceType: material.sourceType ?? "unknown",
              sourceContent: material.content ?? "",
              today: today as string,
              vaultDir: VAULT_DISCOVERIES,
            });
            const output = await infer(prompt, {
              task: "summary",
              component: "discovery-capture",
              action: "discovery.capture.generate",
              system: "You are a discovery analysis assistant that writes discovery notes using Vault conventions.",
              metadata: {
                sourceType: material.sourceType ?? "unknown",
                hasContext: Boolean(context),
                hasUrl: Boolean(url),
              },
            });
            const textOutput = output.text;
            const match = textOutput.match(/DISCOVERY_WRITTEN:(.+)/);
            const noteName = match?.[1]?.trim() ?? `Discovery ${today}`;
            const vaultPath = `${VAULT_DISCOVERIES}/${noteName}.md`;

            return { noteName, vaultPath, piOutput: textOutput.slice(-200) };
          });

          // Step 3: Verify + slog
          const title = await step.run("slog-result", async () => {
            const exists = await Bun.file(result.vaultPath).exists();
            if (!exists) {
              console.error(`Discovery note not written: ${result.vaultPath}`);
              return result.noteName;
            }

            // Read title from the written file
            const content = await Bun.file(result.vaultPath).text();
            const titleMatch = content.match(/^# (.+)$/m);
            const resolvedTitle = titleMatch?.[1] ?? result.noteName;

            await $`slog write --action noted --tool discovery --detail "${resolvedTitle}" --reason "vault:Resources/discoveries/${result.noteName}.md"`.quiet();
            return resolvedTitle;
          });

          await step.run("otel-discovery-investigate-completed", async () => {
            await emitOtelEvent({
              level: "info",
              source: "worker",
              component: "discovery-capture",
              action: "discovery.investigate.completed",
              success: true,
              metadata: {
                url: url ?? null,
                slug: result.noteName,
                title,
              },
            });
          });

          // Ensure in system_knowledge (ADR-0199 invariant)
          try {
            const { ensureKnowledge } = await import("../../lib/typesense");
            await ensureKnowledge({
              id: `discovery:${result.noteName}`,
              type: "insight",
              title: title || result.noteName,
              content: `Discovery: ${url ?? result.noteName}. ${result.noteName}`,
              source: `vault:Resources/discoveries/${result.noteName}.md`,
              tags: ["discovery"],
            });
          } catch { /* graceful */ }

          const discoveryCapturedData = buildDiscoveryCapturedEventData({
            vaultPath: result.vaultPath,
            topic: result.noteName,
            slug: result.noteName,
            url,
            title,
          });

          const discoveryCapturedMode = shouldQueueDiscoveryCaptured() ? "queue" : "inngest";
          const queueResult = discoveryCapturedMode === "queue"
            ? await step.run("queue-discovery-captured", async () => enqueueRegisteredQueueEvent({
                name: "discovery/captured",
                data: discoveryCapturedData as Record<string, unknown>,
                source: "inngest:discovery-capture",
                metadata: {
                  trigger: event.name,
                },
              }))
            : null;

          if (discoveryCapturedMode === "inngest") {
            await step.sendEvent("emit-discovery-captured", {
              name: "discovery/captured",
              data: discoveryCapturedData,
            });
          }

          await step.run("otel-discovery-captured-forwarded", async () => {
            await emitOtelEvent({
              level: "info",
              source: "worker",
              component: "discovery-capture",
              action: "discovery.capture.forwarded",
              success: true,
              metadata: {
                mode: discoveryCapturedMode,
                slug: result.noteName,
                url: url ?? null,
                queueStreamId: queueResult?.streamId ?? null,
                eventId: queueResult?.eventId ?? null,
              },
            });
          });

          // Notify gateway
          if (gateway) {
            try {
              await gateway.notify("discovery.captured", {
                topic: result.noteName,
                url: url ?? null,
              });
            } catch {}
          }

          return { status: "captured", ...result };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await emitOtelEvent({
            level: "error",
            source: "worker",
            component: "discovery-capture",
            action: "discovery.investigate.failed",
            success: false,
            error: message,
            metadata: {
              url: url ?? null,
            },
          });
          throw error;
        }
      }
    );
  }
);
