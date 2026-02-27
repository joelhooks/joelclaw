import type { MessageCreateOptions } from "discord.js";
import * as Discord from "discord.js";

// discord.js exports these at runtime, but the type surface can lag behind.
const Runtime = Discord as unknown as {
  ContainerBuilder: new () => any;
  TextDisplayBuilder: new () => any;
  SeparatorBuilder: new () => any;
  SectionBuilder: new () => any;
  MediaGalleryBuilder: new () => any;
  ThumbnailBuilder: new () => any;
  ActionRowBuilder: new () => any;
  ButtonBuilder: new () => any;
  ButtonStyle: typeof Discord.ButtonStyle;
};

export const ContainerBuilder = Runtime.ContainerBuilder;
export const TextDisplayBuilder = Runtime.TextDisplayBuilder;
export const SeparatorBuilder = Runtime.SeparatorBuilder;
export const SectionBuilder = Runtime.SectionBuilder;
export const MediaGalleryBuilder = Runtime.MediaGalleryBuilder;
export const ThumbnailBuilder = Runtime.ThumbnailBuilder;
export const ActionRowBuilder = Runtime.ActionRowBuilder;
export const ButtonBuilder = Runtime.ButtonBuilder;
export const ButtonStyle = Runtime.ButtonStyle;

export function withComponentsV2(components: readonly unknown[], extra?: Partial<MessageCreateOptions>): MessageCreateOptions {
  return {
    ...(extra ?? {}),
    components: components as MessageCreateOptions["components"],
    flags: Discord.MessageFlags.IsComponentsV2,
  } satisfies MessageCreateOptions;
}
