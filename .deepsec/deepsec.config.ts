import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    {
      id: "joelclaw",
      root: "..",
      priorityPaths: [
        "apps/web/app/api/",
        "packages/system-bus/src/",
        "packages/gateway/src/",
        "packages/cli/src/commands/",
        "k8s/",
      ],
      promptAppend:
        "Prioritize externally-triggered route handlers, webhook verification, secret handling, shell execution, agent prompt/tool boundaries, and Inngest serve endpoints. Treat skills/docs examples as lower priority unless they are executable scripts.",
    },
    // <deepsec:projects-insert-above>
  ],
});
