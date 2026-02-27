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

export type SessionCardData = {
  threadName?: string;
  status: "active" | "idle" | "archived" | "pending";
  age?: string;
  messageCount?: number;
  model?: string;
  details?: string;
  actions?: readonly ButtonSpec[];
};

function accentForStatus(status: SessionCardData["status"]): number {
  switch (status) {
    case "active": return ACCENT.healthy;
    case "idle": return ACCENT.warning;
    case "archived": return ACCENT.neutral;
    default: return ACCENT.info;
  }
}

export function renderSessionCard(data: SessionCardData): MessageCreateOptions {
  const lines = [
    `Status: ${data.status}`,
    `Age: ${data.age ?? "—"}`,
    `Messages: ${data.messageCount ?? "—"}`,
    `Model: ${data.model ?? "—"}`,
  ];

  const container = new ContainerBuilder()
    .setAccentColor(accentForStatus(data.status))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("### 📋 Thread Session"),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const section = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🧵 ${truncate(data.threadName ?? "Current channel", 120)}`),
      new TextDisplayBuilder().setContent(lines.join("   ")),
      new TextDisplayBuilder().setContent(truncate(data.details ?? "", 200) || "Session lifecycle controls."),
    )
    .setButtonAccessory(buildButton({
      id: "session:inspect",
      label: "Inspect",
      style: "secondary",
    }));

  container.addSectionComponents(section);

  addButtonsRow(container, data.actions ?? [
    { id: "session:fork", label: "Fork", style: "secondary" },
    { id: "session:compact", label: "Compact", style: "primary" },
    { id: "session:archive", label: "Archive", style: "danger" },
    { id: "session:resume", label: "Resume", style: "success" },
  ]);

  return withComponentsV2([container]);
}
