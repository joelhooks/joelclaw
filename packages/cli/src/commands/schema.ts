import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond } from "../response"

export const schemaCmd = Command.make(
  "schema",
  {},
  () =>
    Effect.gen(function* () {
      const events = {
        "pipeline/video.download": {
          description: "Download video + NAS transfer → chains to transcript.process",
          data: { url: "string (required)", maxQuality: "string (optional, default: 1080)" },
          example: `igs send pipeline/video.download --url "https://youtube.com/watch?v=XXXX"`,
        },
        "pipeline/transcript.process": {
          description: "Transcribe audio or accept raw text → vault note → chains to content/summarize",
          data: {
            source: "string (required: youtube|granola|fathom|podcast|manual)",
            audioPath: "string (if source needs whisper)",
            text: "string (if raw text, no whisper)",
            title: "string (required)",
            slug: "string (required)",
          },
          example: `igs send pipeline/transcript.process -d '{"source":"granola","text":"...","title":"Meeting","slug":"meeting"}'`,
        },
        "content/summarize": {
          description: "Enrich a vault note with pi + web research",
          data: { vaultPath: "string (required)", prompt: "string (optional)" },
          example: `igs send content/summarize -d '{"vaultPath":"/Users/joel/Vault/Resources/videos/some-note.md"}'`,
        },
        "system/log": {
          description: "Write a canonical system log entry",
          data: { action: "string (required)", tool: "string (required)", detail: "string (required)", reason: "string (optional)" },
          example: `igs send system/log -d '{"action":"test","tool":"cli","detail":"igs test"}'`,
        },
        "agent/loop.start": {
          description: "Start a durable coding loop from a PRD",
          data: { loopId: "string", project: "string (abs path)", prdPath: "string (relative)" },
          example: `igs loop start --project ~/Code/project --prd prd.json`,
        },
      }

      yield* Console.log(respond("schema", events, [
        { command: `igs send pipeline/video.download --url "https://youtube.com/watch?v=XXXX"`, description: "Download a video" },
        { command: `igs send system/log -d '{"action":"test","tool":"cli","detail":"igs test"}'`, description: "Send a test log event" },
        { command: `igs functions`, description: "See registered functions and their triggers" },
      ]))
    })
)
