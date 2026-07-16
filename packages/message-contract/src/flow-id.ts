import { randomUUID } from "node:crypto";
import { Schema } from "effect";

const FLOW_ID_PATTERN = /^flow_v2_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const FlowId = Schema.String.pipe(Schema.pattern(FLOW_ID_PATTERN), Schema.brand("FlowId"));
export type FlowId = typeof FlowId.Type;

export function mintFlowId(uuid: () => string = randomUUID): FlowId {
  return Schema.decodeUnknownSync(FlowId)(`flow_v2_${uuid()}`);
}
