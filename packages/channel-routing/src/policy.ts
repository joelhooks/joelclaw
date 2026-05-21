import { AbilityBuilder, createMongoAbility, subject, type MongoAbility } from "@casl/ability";
import type { ChannelAction, ChannelPermissionPolicy, ChannelPrincipal, ChannelSubject, ChannelSubjectType } from "./types";

type AppAbility = MongoAbility<[ChannelAction, ChannelSubjectType], Record<string, unknown>>;

function subjectType(item: ChannelSubject): ChannelSubjectType {
  return item.kind;
}

export function buildChannelAbility(
  principal: ChannelPrincipal,
  policy: ChannelPermissionPolicy = { principals: {} },
): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  const role = policy.principals[principal.userId] ?? principal.role;

  if (role === "blocked") {
    cannot("mention", "SlackUser");
    cannot("requestGrant", "ReplyGrant");
    cannot("consumeGrant", "ReplyGrant");
    cannot("autoInvoke", "ReplyGrant");
    cannot("administer", "ReplyGrant");
    return build({ detectSubjectType: subjectType });
  }

  if (role === "owner") {
    can(["mention", "requestGrant", "consumeGrant", "autoInvoke", "administer"], ["SlackThread", "SlackChannel", "SlackUser", "ReplyGrant"]);
    return build({ detectSubjectType: subjectType });
  }

  if (role === "trusted-collaborator") {
    can(["mention", "requestGrant"], ["SlackThread", "SlackChannel", "SlackUser", "ReplyGrant"]);
    can(["consumeGrant", "autoInvoke"], "ReplyGrant", { invokerUserIds: { $in: [principal.userId] } });
    return build({ detectSubjectType: subjectType });
  }

  if (role === "participant") {
    can("mention", ["SlackThread", "SlackChannel", "SlackUser"]);
    can(["consumeGrant", "autoInvoke"], "ReplyGrant", { invokerUserIds: { $in: [principal.userId] } });
    return build({ detectSubjectType: subjectType });
  }

  can("mention", ["SlackThread", "SlackChannel", "SlackUser"]);
  return build({ detectSubjectType: subjectType });
}

export function canChannel(
  principal: ChannelPrincipal,
  action: ChannelAction,
  item: ChannelSubject,
  policy?: ChannelPermissionPolicy,
): boolean {
  const ability = buildChannelAbility(principal, policy);
  return ability.can(action, subject(item.kind, item) as never);
}

export function isChannelEligible(channelId: string, policy: ChannelPermissionPolicy): boolean {
  if (policy.channelBlocklist?.includes(channelId)) return false;
  if (!policy.channelAllowlist || policy.channelAllowlist.length === 0) return true;
  return policy.channelAllowlist.includes(channelId);
}
