/**
 * Discord UI Components — interactive React components for Discord messages.
 *
 * Also re-exports discordjs-react primitives for custom components.
 */


// ── Re-export discordjs-react primitives for custom components ────
export {
  ActionRow,
  Button,
  Embed,
  EmbedAuthor,
  EmbedField,
  EmbedFooter,
  EmbedImage,
  EmbedThumbnail,
  EmbedTitle,
  Link,
  Option,
  Select,
} from "@answeroverflow/discordjs-react";
export type { AgentResponseAction, AgentResponseProps } from "./agent-response.tsx";

export { AgentResponse } from "./agent-response.tsx";
export type { ApprovalProps } from "./approval.tsx";
export { Approval } from "./approval.tsx";
export type { McqFlowProps, McqQuestionData } from "./mcq.tsx";
// ── High-level components ──────────────────────────────────────────
export { McqFlow } from "./mcq.tsx";
export type { SelectOption, SelectPromptProps } from "./select-prompt.tsx";

export { SelectPrompt } from "./select-prompt.tsx";
export type { StatusCardProps, StatusField, StatusState } from "./status-card.tsx";
export { StatusCard } from "./status-card.tsx";
