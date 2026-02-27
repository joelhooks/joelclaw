import type { MessageCreateOptions } from "discord.js";
import { type AccentToken, accentColor } from "../helpers/accent-color";
import { addButtonsRow, type ButtonSpec, buildButton } from "../helpers/button";
import { type KeyValueRow, monospaceTable } from "../helpers/format";
import { truncate } from "../helpers/truncate";
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  withComponentsV2,
} from "../helpers/v2-builders";

export type StatusContainerData = {
  title: string;
  subtitle?: string;
  level?: AccentToken;
  metrics?: readonly KeyValueRow[];
  notes?: readonly string[];
  actions?: readonly ButtonSpec[];
};

function statusEmoji(level: AccentToken): string {
  switch (level) {
    case "healthy": return "🟢";
    case "warning": return "🟡";
    case "error": return "🔴";
    case "info": return "🔵";
    default: return "⚪";
  }
}

export function renderStatusContainer(data: StatusContainerData): MessageCreateOptions {
  const level = data.level ?? "neutral";
  const metrics = data.metrics ?? [];

  const container = new ContainerBuilder()
    .setAccentColor(accentColor(level))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${statusEmoji(level)} ${truncate(data.title, 120)}`),
    );

  if (data.subtitle?.trim()) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(truncate(data.subtitle, 320)),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  const topMetrics = metrics.slice(0, 3);
  const section = new SectionBuilder();
  const metricDisplays = topMetrics.length > 0
    ? topMetrics.map((metric) => new TextDisplayBuilder().setContent(`**${truncate(metric.key, 36)}:** ${truncate(metric.value, 120)}`))
    : [new TextDisplayBuilder().setContent("No status metrics available.")];

  section.addTextDisplayComponents(...metricDisplays);
  section.setButtonAccessory(buildButton((data.actions ?? [])[0] ?? {
    id: "status:refresh",
    label: "Refresh",
    style: "secondary",
  }));

  container.addSectionComponents(section);

  if (metrics.length > topMetrics.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        monospaceTable(metrics.slice(topMetrics.length, topMetrics.length + 8)),
      ),
    );
  }

  if (data.notes?.length) {
    container.addSeparatorComponents(new SeparatorBuilder());
    const notesText = data.notes
      .slice(0, 4)
      .map((note) => `- ${truncate(note, 160)}`)
      .join("\n");
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(notesText));
  }

  addButtonsRow(container, (data.actions ?? []).slice(0, 5));

  return withComponentsV2([container]);
}
