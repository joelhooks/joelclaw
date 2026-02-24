import type { MessageCreateOptions } from "discord.js";
import { ACCENT } from "../helpers/accent-color";
import { buildButton } from "../helpers/button";
import { truncate } from "../helpers/truncate";
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  withComponentsV2,
} from "../helpers/v2-builders";

export type HeartbeatDigestData = {
  timestampLabel: string;
  summary: string;
  metricsLine?: string;
};

export function renderHeartbeatDigest(data: HeartbeatDigestData): MessageCreateOptions {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.healthy)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 💓 ${truncate(data.timestampLabel, 64)}`),
      new TextDisplayBuilder().setContent(truncate(data.summary, 180)),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const section = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(truncate(data.metricsLine ?? "W:? I:? R:? T:? E:?", 160)),
    )
    .setButtonAccessory(buildButton({
      id: "heartbeat:expand",
      label: "Expand",
      style: "secondary",
    }));

  container.addSectionComponents(section);

  return withComponentsV2([container]);
}
