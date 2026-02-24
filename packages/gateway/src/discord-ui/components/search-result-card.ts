import type { MessageCreateOptions } from "discord.js";
import { accentFromScore } from "../helpers/accent-color";
import { addButtonsRow, buildButton, type ButtonSpec } from "../helpers/button";
import { truncate } from "../helpers/truncate";
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  withComponentsV2,
} from "../helpers/v2-builders";

export type SearchResultItem = {
  score: number;
  title: string;
  context?: string;
  href?: string;
};

export type SearchResultCardData = {
  query: string;
  source?: "search" | "recall";
  results: readonly SearchResultItem[];
  actions?: readonly ButtonSpec[];
};

function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "0.00";
  return score.toFixed(2);
}

export function renderSearchResultCard(data: SearchResultCardData): MessageCreateOptions {
  const topScore = data.results[0]?.score ?? 0;
  const title = data.source === "recall" ? "Recall" : "Search";

  const container = new ContainerBuilder()
    .setAccentColor(accentFromScore(topScore))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🔍 ${title}: \`${truncate(data.query, 80)}\``),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const items = data.results.slice(0, 6);
  if (items.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("No results found."),
    );
  }

  for (const [index, item] of items.entries()) {
    const section = new SectionBuilder();
    const first = `▸ [${formatScore(item.score)}] **${truncate(item.title, 100)}**`;
    const second = item.context ? `"${truncate(item.context, 180)}"` : "";
    const displays = [first, second].filter(Boolean).map((line) => new TextDisplayBuilder().setContent(line));
    section.addTextDisplayComponents(...displays);

    if (item.href) {
      section.setButtonAccessory(buildButton({
        label: "Open",
        style: "link",
        url: item.href,
      }));
    } else {
      section.setButtonAccessory(buildButton({
        id: `search:view:${index}`,
        label: "View",
        style: "secondary",
      }));
    }

    container.addSectionComponents(section);
  }

  addButtonsRow(container, data.actions ?? [
    { id: "search:more", label: "More", style: "secondary" },
    { id: "search:refine", label: "Refine", style: "primary" },
    { id: "search:save", label: "Save to Vault", style: "success" },
  ]);

  return withComponentsV2([container]);
}
