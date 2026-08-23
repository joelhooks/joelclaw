import { expect, test } from "bun:test"

import { VIP_MEMORY_RECALL_POLICY } from "./vip-email-recall-policy"

test("VIP composed recall policy disables legacy echo/fizzle mutation", () => {
  expect(VIP_MEMORY_RECALL_POLICY).toEqual({
    scope: { project: "joelclaw-fleet", workstream: "default" },
    access: {
      principalRef: "service:vip-email",
      purpose: "vip-email-brief",
      allowedPrivacy: ["public", "private"],
    },
    legacyEchoFizzle: "disabled",
  })
})
