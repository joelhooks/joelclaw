export const VIP_MEMORY_RECALL_POLICY = {
  scope: { project: "joelclaw-fleet", workstream: "default" },
  access: {
    principalRef: "service:vip-email",
    purpose: "vip-email-brief",
    allowedPrivacy: ["public", "private"],
  },
  legacyEchoFizzle: "disabled",
} as const
