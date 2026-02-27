/**
 * StatusCard — Live-updating status embed (ADR-0122)
 *
 * Renders a status indicator that updates in place.
 * Use for processing states, loop progress, health checks.
 */

import {
  ActionRow,
  Button,
  Embed,
} from "@answeroverflow/discordjs-react";
import type { ButtonInteraction } from "discord.js";
import React, { useCallback, useEffect, useRef, useState } from "react";

export type StatusState = "processing" | "done" | "error" | "waiting" | "cancelled";

const STATUS_CONFIG: Record<StatusState, { emoji: string; color: number; label: string }> = {
  processing: { emoji: "⏳", color: 0xf1c40f, label: "Processing" },
  done:       { emoji: "✅", color: 0x2ecc71, label: "Done" },
  error:      { emoji: "❌", color: 0xe74c3c, label: "Error" },
  waiting:    { emoji: "⏸️", color: 0x95a5a6, label: "Waiting" },
  cancelled:  { emoji: "🚫", color: 0x95a5a6, label: "Cancelled" },
};

export type StatusField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type StatusCardProps = {
  title: string;
  description?: string;
  initialState?: StatusState;
  fields?: StatusField[];
  cancelable?: boolean;
  onCancel?: (interaction: ButtonInteraction) => Promise<unknown> | unknown;
};

/**
 * A status card that can be updated programmatically.
 *
 * Returns a controller via the onMount callback that allows
 * external code to update the status and fields.
 */
export function StatusCard({
  title,
  description,
  initialState = "processing",
  fields = [],
  cancelable = false,
  onCancel,
}: StatusCardProps) {
  const [state, setState] = useState<StatusState>(initialState);
  const [currentFields, setFields] = useState<StatusField[]>(fields);
  const [currentDesc, setDesc] = useState(description);

  const config = STATUS_CONFIG[state];
  const isTerminal = state === "done" || state === "error" || state === "cancelled";

  return (
    <>
      <Embed
        color={config.color}
        fields={currentFields.length > 0 ? currentFields : undefined}
        timestamp={isTerminal ? new Date() : undefined}
      >
        {`${config.emoji} **${title}** — ${config.label}${currentDesc ? `\n\n${currentDesc}` : ""}`}
      </Embed>
      {cancelable && !isTerminal && (
        <ActionRow>
          <Button
            label="Cancel"
            style="Danger"
            onClick={async (interaction) => {
              setState("cancelled");
              await onCancel?.(interaction);
            }}
          />
        </ActionRow>
      )}
    </>
  );
}
