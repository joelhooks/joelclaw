import type { MessageCreateOptions } from "discord.js";
import { accentFromRunStatus } from "../helpers/accent-color";
import { addButtonsRow, type ButtonSpec, buildButton } from "../helpers/button";
import { truncate } from "../helpers/truncate";
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  withComponentsV2,
} from "../helpers/v2-builders";

export type RunCardItem = {
  status: string;
  name: string;
  age: string;
  duration?: string;
};

export type RunCardData = {
  title?: string;
  runs: readonly RunCardItem[];
  actions?: readonly ButtonSpec[];
};

function statusEmoji(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "❌";
  if (s.includes("slow") || s.includes("warn")) return "⚠️";
  if (s.includes("ok") || s.includes("success")) return "✅";
  return "•";
}

export function renderRunCard(data: RunCardData): MessageCreateOptions {
  const runs = data.runs.slice(0, 8);
  const statuses = runs.map((run) => run.status);

  const container = new ContainerBuilder()
    .setAccentColor(accentFromRunStatus(statuses))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🏃 ${truncate(data.title ?? "Recent Runs", 80)}`),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (runs.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("No recent runs found."));
    return withComponentsV2([container]);
  }

  const first = runs[0]!;
  const section = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${truncate(first.name, 80)}**`),
      new TextDisplayBuilder().setContent(`${statusEmoji(first.status)} ${truncate(first.status, 40)} · ${truncate(first.age, 28)} · ${truncate(first.duration ?? "—", 16)}`),
    )
    .setButtonAccessory(buildButton({
      id: `runs:view:${first.name}`,
      label: "View",
      style: "secondary",
    }));
  container.addSectionComponents(section);

  if (runs.length > 1) {
    const lines = runs.slice(1).map((run) => {
      const status = truncate(run.status, 12).padEnd(12, " ");
      const name = truncate(run.name, 28).padEnd(28, " ");
      const age = truncate(run.age, 12).padEnd(12, " ");
      const duration = truncate(run.duration ?? "—", 10).padEnd(10, " ");
      return `${statusEmoji(run.status)} ${status} ${name} ${age} ${duration}`;
    });

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`\`\`\`txt\n${lines.join("\n")}\n\`\`\``),
    );
  }

  addButtonsRow(container, data.actions ?? [
    { id: "runs:failed", label: "View Failed", style: "danger" },
    { id: "runs:retry", label: "Retry", style: "secondary" },
    { id: "runs:all", label: "All Runs", style: "primary" },
  ]);

  return withComponentsV2([container]);
}
