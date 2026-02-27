import type { MessageCreateOptions } from "discord.js";
import { ACCENT } from "../helpers/accent-color";
import { addButtonsRow, type ButtonSpec, buildButton } from "../helpers/button";
import { truncate } from "../helpers/truncate";
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  withComponentsV2,
} from "../helpers/v2-builders";

export type ApprovalState = "pending" | "approved" | "denied";

export type ApprovalCardData = {
  title?: string;
  targetPath: string;
  change: string;
  risk?: string;
  state?: ApprovalState;
  actions?: readonly ButtonSpec[];
};

function accentForState(state: ApprovalState): number {
  switch (state) {
    case "approved": return ACCENT.healthy;
    case "denied": return ACCENT.error;
    default: return ACCENT.warning;
  }
}

function stateLabel(state: ApprovalState): string {
  switch (state) {
    case "approved": return "✅ Approved";
    case "denied": return "❌ Denied";
    default: return "⚠️ Approval Required";
  }
}

export function renderApprovalCard(data: ApprovalCardData): MessageCreateOptions {
  const state = data.state ?? "pending";
  const disabled = state !== "pending";

  const container = new ContainerBuilder()
    .setAccentColor(accentForState(state))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${stateLabel(state)}`),
      ...(data.title ? [new TextDisplayBuilder().setContent(truncate(data.title, 180))] : []),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const section = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Target:** \`${truncate(data.targetPath, 140)}\``),
      new TextDisplayBuilder().setContent(`**Change:** ${truncate(data.change, 220)}`),
      new TextDisplayBuilder().setContent(`**Risk:** ${truncate(data.risk ?? "Unknown", 120)}`),
    )
    .setButtonAccessory(buildButton({
      id: "approval:diff",
      label: "Diff",
      style: "secondary",
      disabled,
    }));

  container.addSectionComponents(section);

  addButtonsRow(container, data.actions ?? [
    { id: "approval:yes", label: "Approve", style: "success", disabled },
    { id: "approval:no", label: "Deny", style: "danger", disabled },
    { id: "approval:diff", label: "Diff", style: "secondary" },
  ]);

  return withComponentsV2([container]);
}
