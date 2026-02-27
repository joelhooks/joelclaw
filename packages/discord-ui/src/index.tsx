/**
 * @joelclaw/discord-ui — React components for interactive Discord messages (ADR-0122)
 *
 * Built on discordjs-react (React reconciler for Discord).
 * Provides composable, stateful UI components that render to
 * Discord embeds, buttons, selects, and action rows.
 *
 * Usage from gateway:
 *   import { initDiscordUI, renderToChannel } from "@joelclaw/discord-ui";
 *   import { McqFlow } from "@joelclaw/discord-ui/components";
 */

export type { RenderMcqOptions } from "./helpers/render-mcq.tsx";
export { renderMcqToChannel } from "./helpers/render-mcq.tsx";
export type { DiscordUIInstance } from "./runtime.ts";
export { getDiscordUI, initDiscordUI, renderToChannel, shutdownDiscordUI } from "./runtime.ts";
