import { describe, expect, test } from "bun:test"
import { buildRetroRequestPayload } from "./retro"

describe("retro command payload", () => {
  test("resolves the brief from the repository and preserves hook metadata", () => {
    const payload = buildRetroRequestPayload({
      briefPath: ".brain/projects/example/brief.svx",
      cwd: "/tmp/elsewhere",
      repo: "/tmp/example-repo",
      requestedBy: "pi-session-close",
      sessionId: "session-123",
    })

    expect(payload).toEqual({
      brief_path: "/tmp/example-repo/.brain/projects/example/brief.svx",
      repo: "/tmp/example-repo",
      requested_by: "pi-session-close",
      session_id: "session-123",
    })
  })

  test("defaults repo and requester for the one-line hook surface", () => {
    const payload = buildRetroRequestPayload({
      briefPath: "brief.svx",
      cwd: "/tmp/example-repo",
    })

    expect(payload).toEqual({
      brief_path: "/tmp/example-repo/brief.svx",
      repo: "/tmp/example-repo",
      requested_by: "joelclaw-cli",
    })
  })
})
