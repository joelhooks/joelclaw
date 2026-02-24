/**
 * AgentResponse — Rich embed for agent text responses (ADR-0122)
 *
 * Formats agent output as a Discord embed with proper markdown,
 * code block handling, and optional action buttons.
 */

import React from "react";
import {
  Embed,
  Button,
  ActionRow,
  Link,
} from "@answeroverflow/discordjs-react";
import type { ButtonInteraction } from "discord.js";

export type AgentResponseAction = {
  label: string;
  style?: "Primary" | "Secondary" | "Success" | "Danger";
  onClick?: (interaction: ButtonInteraction) => Promise<unknown> | unknown;
  url?: string; // For link buttons
};

export type AgentResponseProps = {
  text: string;
  title?: string;
  color?: number;
  actions?: AgentResponseAction[];
  footer?: string;
  timestamp?: boolean;
};

const DEFAULT_COLOR = 0x2b2d31; // Discord dark embed

/**
 * Renders agent text as a rich Discord embed.
 * If the text is short enough (<4096 chars), uses a single embed.
 * If longer, chunks into multiple embeds.
 */
export function AgentResponse({
  text,
  title,
  color = DEFAULT_COLOR,
  actions,
  footer,
  timestamp,
}: AgentResponseProps) {
  const maxEmbedDesc = 4096;

  // Split long text into chunks that fit in embed descriptions
  const chunks = chunkText(text, maxEmbedDesc);
  const hasActions = actions && actions.length > 0;

  return (
    <>
      {chunks.map((chunk, i) => (
        <Embed
          key={i}
          title={i === 0 ? title : undefined}
          color={color}
          footer={i === chunks.length - 1 && footer ? { text: footer } : undefined}
          timestamp={i === chunks.length - 1 && timestamp ? new Date() : undefined}
        >
          {chunk}
        </Embed>
      ))}
      {hasActions && (
        <ActionRow>
          {actions.map((action, i) =>
            action.url ? (
              <Link key={i} label={action.label} url={action.url} />
            ) : (
              <Button
                key={i}
                label={action.label}
                style={action.style ?? "Secondary"}
                onClick={async (interaction) => {
                  await action.onClick?.(interaction);
                }}
              />
            ),
          )}
        </ActionRow>
      )}
    </>
  );
}

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph break, then newline, then space
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < maxLength * 0.3) splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.3) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < maxLength * 0.3) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
