import { Schema } from "effect";
import { MessageRouteNotFoundError } from "./errors";
import {
  FormattingProfile,
  MESSAGE_CONTRACT_VERSION,
  MessageDeliveryMode,
  type MessageKind,
  MessagePlatform,
} from "./kinds";

export const MessageRoute = Schema.Struct({
  platform: MessagePlatform,
  delivery: MessageDeliveryMode,
  formatting: FormattingProfile,
});
export interface MessageRoute extends Schema.Schema.Type<typeof MessageRoute> {}

export const RoutingTableV2 = Schema.Struct({
  version: Schema.Literal(MESSAGE_CONTRACT_VERSION),
  routes: Schema.Struct({
    memory: MessageRoute,
    alert: MessageRoute,
    digest: MessageRoute,
    ask: MessageRoute,
    receipt: MessageRoute,
  }),
});
export interface RoutingTableV2 extends Schema.Schema.Type<typeof RoutingTableV2> {}

export const ROUTING_TABLE_V2: RoutingTableV2 = Schema.decodeUnknownSync(RoutingTableV2)({
  version: MESSAGE_CONTRACT_VERSION,
  routes: {
    memory: { platform: "telegram", delivery: "immediate", formatting: "markdown" },
    alert: { platform: "telegram", delivery: "immediate", formatting: "markdown" },
    digest: { platform: "telegram", delivery: "batch", formatting: "markdown" },
    ask: { platform: "telegram", delivery: "immediate", formatting: "markdown" },
    receipt: { platform: "slack", delivery: "immediate", formatting: "markdown" },
  },
});

export function resolveMessageRoute(
  kind: MessageKind,
  table: RoutingTableV2 = ROUTING_TABLE_V2,
): MessageRoute {
  const route = table.routes[kind];
  if (!route) {
    throw new MessageRouteNotFoundError({
      operation: "message-contract.resolve-route",
      code: "MESSAGE_ROUTE_NOT_FOUND",
      kind,
      fix: `Add ${kind} to the versioned routing table before sending it.`,
    });
  }
  return route;
}
