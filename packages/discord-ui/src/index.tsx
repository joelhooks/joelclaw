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

export { initDiscordUI, getDiscordUI, renderToChannel, shutdownDiscordUI } from "./runtime.ts";
export type { DiscordUIInstance } from "./runtime.ts";
export { renderMcqToChannel } from "./helpers/render-mcq.tsx";
export type { RenderMcqOptions } from "./helpers/render-mcq.tsx";
