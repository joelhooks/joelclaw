import { emitOtelEvent } from "../../observability/emit";

export async function emitInngestRegistryLoaded(functionIds: string[]): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: "inngest.functions",
    action: "registry.loaded",
    success: true,
    metadata: {
      count: functionIds.length,
      functionIds,
    },
  });
}
