/**
 * Approval — Yes/No confirmation flow (ADR-0122)
 *
 * Interactive approval prompt. Updates in place when answered.
 * Use for destructive actions, deploy confirmations, etc.
 */

import {
  ActionRow,
  Button,
  Embed,
} from "@answeroverflow/discordjs-react";
import type { ButtonInteraction } from "discord.js";
import React, { useRef, useState } from "react";

export type ApprovalProps = {
  prompt: string;
  description?: string;
  approveLabel?: string;
  rejectLabel?: string;
  onDecision: (approved: boolean, interaction: ButtonInteraction) => Promise<unknown> | unknown;
  timeoutMs?: number;
};

/**
 * Renders an approval prompt with Approve/Reject buttons.
 * Updates the message in place when a decision is made.
 */
export function Approval({
  prompt,
  description,
  approveLabel = "Approve",
  rejectLabel = "Reject",
  onDecision,
  timeoutMs,
}: ApprovalProps) {
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const settledRef = useRef(false);

  if (decision) {
    const isApproved = decision === "approved";
    return (
      <Embed color={isApproved ? 0x2ecc71 : 0xe74c3c}>
        {`**${prompt}**\n\n${isApproved ? "✅ Approved" : "❌ Rejected"}`}
      </Embed>
    );
  }

  return (
    <>
      <Embed color={0xf39c12}>
        {`**${prompt}**${description ? `\n\n${description}` : ""}`}
      </Embed>
      <ActionRow>
        <Button
          label={approveLabel}
          style="Success"
          onClick={async (interaction) => {
            if (settledRef.current) return;
            settledRef.current = true;
            setDecision("approved");
            await onDecision(true, interaction);
          }}
        />
        <Button
          label={rejectLabel}
          style="Danger"
          onClick={async (interaction) => {
            if (settledRef.current) return;
            settledRef.current = true;
            setDecision("rejected");
            await onDecision(false, interaction);
          }}
        />
      </ActionRow>
    </>
  );
}
