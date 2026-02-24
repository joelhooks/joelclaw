export { ACCENT, accentColor, accentFromRunStatus, accentFromScore, type AccentToken } from "./helpers/accent-color";
export { truncate } from "./helpers/truncate";
export { monospaceTable, stripAnsi, type KeyValueRow } from "./helpers/format";

export { renderStatusContainer, type StatusContainerData } from "./components/status-container";
export { renderSearchResultCard, type SearchResultCardData, type SearchResultItem } from "./components/search-result-card";
export { renderMcqFlow, type McqFlowData } from "./components/mcq-flow";
export { renderRunCard, type RunCardData, type RunCardItem } from "./components/run-card";
export { renderDiscoveryCard, type DiscoveryCardData } from "./components/discovery-card";
export { renderApprovalCard, type ApprovalCardData, type ApprovalState } from "./components/approval-card";
export { renderSessionCard, type SessionCardData } from "./components/session-card";
export { renderHeartbeatDigest, type HeartbeatDigestData } from "./components/heartbeat-digest";

export { DISCORD_SLASH_COMMANDS, registerDiscordSlashCommands, type SlashRegistrationResult } from "./slash-commands/register";
export { handleDiscordSlashCommand, type DiscordSlashHandlerDeps } from "./slash-commands/handler";
