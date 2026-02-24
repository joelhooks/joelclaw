/**
 * Discord UI Components — interactive React components for Discord messages.
 *
 * Also re-exports discordjs-react primitives for custom components.
 */

// ── High-level components ──────────────────────────────────────────
export { McqFlow } from "./mcq.tsx";
export type { McqFlowProps, McqQuestionData } from "./mcq.tsx";

export { AgentResponse } from "./agent-response.tsx";
export type { AgentResponseProps, AgentResponseAction } from "./agent-response.tsx";

export { StatusCard } from "./status-card.tsx";
export type { StatusCardProps, StatusState, StatusField } from "./status-card.tsx";

export { Approval } from "./approval.tsx";
export type { ApprovalProps } from "./approval.tsx";

export { SelectPrompt } from "./select-prompt.tsx";
export type { SelectPromptProps, SelectOption } from "./select-prompt.tsx";

// ── Re-export discordjs-react primitives for custom components ────
export {
  Embed,
  EmbedTitle,
  EmbedAuthor,
  EmbedField,
  EmbedFooter,
  EmbedImage,
  EmbedThumbnail,
  Button,
  ActionRow,
  Select,
  Option,
  Link,
} from "@answeroverflow/discordjs-react";
