import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "./v2-builders";

export type ButtonTone = "primary" | "secondary" | "success" | "danger" | "link";

export type ButtonSpec = {
  id?: string;
  label: string;
  style?: ButtonTone;
  url?: string;
  disabled?: boolean;
};

function styleToDiscord(style: ButtonTone | undefined): number {
  switch (style) {
    case "primary": return ButtonStyle.Primary;
    case "success": return ButtonStyle.Success;
    case "danger": return ButtonStyle.Danger;
    case "link": return ButtonStyle.Link;
    default: return ButtonStyle.Secondary;
  }
}

export function buildButton(spec: ButtonSpec): any {
  const button = new ButtonBuilder().setLabel(spec.label).setStyle(styleToDiscord(spec.style));

  if (spec.style === "link" && spec.url) {
    button.setURL(spec.url);
  } else {
    const fallbackId = `ui:${spec.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 95);
    button.setCustomId((spec.id ?? fallbackId) || "ui:action");
  }

  if (spec.disabled) {
    button.setDisabled(true);
  }

  return button;
}

export function addButtonsRow(container: any, specs: readonly ButtonSpec[]): void {
  if (!specs.length) return;
  const row = new ActionRowBuilder();
  const limited = specs.slice(0, 5);
  row.addComponents(...limited.map((spec) => buildButton(spec)));
  container.addActionRowComponents(row);
}
