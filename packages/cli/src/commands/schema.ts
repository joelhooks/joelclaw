import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond } from "../response"

export const schemaCmd = Command.make(
  "schema",
  {},
  () =>
    Effect.gen(function* () {
      const events = {
        "pipeline/video.requested": {
          description: "Download video + NAS transfer → chains to transcript.requested",
          data: { url: "string (required)", maxQuality: "string (optional, default: 1080)" },
          example: `joelclaw send pipeline/video.requested --url "https://youtube.com/watch?v=XXXX"`,
          aliases: ["pipeline/video.download"],
        },
        "pipeline/transcript.requested": {
          description: "Transcribe audio or accept raw text → vault note → chains to content/summarize.requested",
          data: {
            source: "string (required: youtube|granola|fathom|podcast|manual)",
            audioPath: "string (if source needs whisper)",
            text: "string (if raw text, no whisper)",
            title: "string (required)",
            slug: "string (required)",
          },
          example: `joelclaw send pipeline/transcript.requested -d '{"source":"granola","text":"...","title":"Meeting","slug":"meeting"}'`,
          aliases: ["pipeline/transcript.process"],
        },
        "content/summarize.requested": {
          description: "Enrich a vault note with pi + web research",
          data: { vaultPath: "string (required)", prompt: "string (optional)" },
          example: `joelclaw send content/summarize.requested -d '{"vaultPath":"/Users/joel/Vault/Resources/videos/some-note.md"}'`,
          aliases: ["content/summarize"],
        },
        "system/log": {
          description: "Write a canonical system log entry",
          data: { action: "string (required)", tool: "string (required)", detail: "string (required)", reason: "string (optional)" },
          example: `joelclaw send system/log -d '{"action":"test","tool":"cli","detail":"joelclaw test"}'`,
        },
        "agent/loop.start": {
          description: "Start a durable coding loop from a PRD",
          data: { loopId: "string", project: "string (abs path)", prdPath: "string (relative)" },
          example: `joelclaw loop start --project ~/Code/project --prd prd.json`,
        },
      }

      yield* Console.log(respond("schema", events, [
        { command: `joelclaw send pipeline/video.requested --url "https://youtube.com/watch?v=XXXX"`, description: "Download a video" },
        { command: `joelclaw send system/log -d '{"action":"test","tool":"cli","detail":"joelclaw test"}'`, description: "Send a test log event" },
        { command: `joelclaw functions`, description: "See registered functions and their triggers" },
      ]))
    })
)
