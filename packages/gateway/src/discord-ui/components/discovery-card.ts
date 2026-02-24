import type { MessageCreateOptions } from "discord.js";
import { ACCENT } from "../helpers/accent-color";
import { addButtonsRow, buildButton, type ButtonSpec } from "../helpers/button";
import { truncate } from "../helpers/truncate";
import {
  ContainerBuilder,
  MediaGalleryBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  withComponentsV2,
} from "../helpers/v2-builders";

export type DiscoveryCardData = {
  title: string;
  url: string;
  snippet?: string;
  imageUrl?: string;
  actions?: readonly ButtonSpec[];
};

export function renderDiscoveryCard(data: DiscoveryCardData): MessageCreateOptions {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.info)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("### 🔗 Discovery"),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (data.imageUrl?.trim()) {
    const gallery = new MediaGalleryBuilder().addItems({
      media: { url: data.imageUrl.trim() },
      description: truncate(data.title, 120),
    });
    container.addMediaGalleryComponents(gallery);
  }

  const section = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${truncate(data.title, 120)}**`),
      new TextDisplayBuilder().setContent(truncate(data.url, 180)),
      new TextDisplayBuilder().setContent(data.snippet ? truncate(data.snippet, 220) : "No preview available."),
    )
    .setButtonAccessory(buildButton({
      label: "Open",
      style: "link",
      url: data.url,
    }));

  container.addSectionComponents(section);

  addButtonsRow(container, data.actions ?? [
    { label: "Open", style: "link", url: data.url },
    { id: "discovery:save", label: "Save to Vault", style: "success" },
    { id: "discovery:dismiss", label: "Dismiss", style: "secondary" },
  ]);

  return withComponentsV2([container]);
}
