import type { MessageCreateOptions } from "discord.js";
import { ACCENT } from "../helpers/accent-color";
import { addButtonsRow, buildButton, type ButtonSpec } from "../helpers/button";
import { truncate } from "../helpers/truncate";
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  withComponentsV2,
} from "../helpers/v2-builders";

export type McqFlowData = {
  id: string;
  title?: string;
  question: string;
  options: readonly string[];
  mode?: "quiz" | "decision";
  recommended?: number;
  recommendedReason?: string;
  timeoutSeconds?: number;
};

export function renderMcqFlow(data: McqFlowData): MessageCreateOptions {
  const mode = data.mode ?? "decision";
  const showRecommendation = mode === "decision";

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.info)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ⚡ ${truncate(data.title ?? "Multiple Choice", 90)}`),
      new TextDisplayBuilder().setContent(`**${truncate(data.question, 280)}**`),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const optionLines = data.options
    .slice(0, 4)
    .map((option, index) => {
      const ordinal = index + 1;
      const badge = showRecommendation && data.recommended === ordinal ? " ★" : "";
      return `${ordinal}. ${truncate(option, 120)}${badge}`;
    });

  const section = new SectionBuilder();
  section.addTextDisplayComponents(
    ...optionLines.slice(0, 3).map((line) => new TextDisplayBuilder().setContent(line)),
  );
  section.setButtonAccessory(buildButton({
    id: `mcq:${data.id}:0`,
    label: `Pick ${data.options[0] ? "1" : "?"}`,
    style: "secondary",
  }));
  container.addSectionComponents(section);

  if (optionLines.length > 3) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(optionLines.slice(3).join("\n")),
    );
  }

  if (showRecommendation && data.recommendedReason?.trim()) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`*Recommended: ${truncate(data.recommendedReason, 240)}*`),
    );
  }

  if (data.timeoutSeconds && data.timeoutSeconds > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`⏱ Auto-select after ${data.timeoutSeconds}s`),
    );
  }

  const buttons: ButtonSpec[] = data.options.slice(0, 4).map((option, index) => {
    const ordinal = index + 1;
    const rec = showRecommendation && data.recommended === ordinal;
    return {
      id: `mcq:${data.id}:${index}`,
      label: `${ordinal}${rec ? " ★" : ""}`,
      style: rec ? "primary" : "secondary",
    };
  });

  buttons.push({
    id: `mcq:${data.id}:other`,
    label: "Other",
    style: "secondary",
  });

  addButtonsRow(container, buttons);

  return withComponentsV2([container]);
}
