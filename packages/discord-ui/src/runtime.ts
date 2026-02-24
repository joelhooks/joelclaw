/**
 * Discord UI runtime — manages the discordjs-react reconciler instance.
 *
 * The gateway calls initDiscordUI(client) once after login.
 * Components call renderToChannel() to send interactive messages.
 */

import type { Client, TextBasedChannel } from "discord.js";
import { DiscordJSReact } from "@answeroverflow/discordjs-react";
import type { ReactNode } from "react";

export type DiscordUIInstance = DiscordJSReact;

let instance: DiscordJSReact | undefined;

/**
 * Initialize the discordjs-react instance with the Discord client.
 * Call once after client.login() succeeds.
 */
export function initDiscordUI(client: Client, maxInstances = 100): DiscordJSReact {
  if (instance) return instance;

  instance = new DiscordJSReact(client, {
    maxInstances,
    wrapper: ({ children }) => children,
  });

  console.log("[discord-ui] initialized", { maxInstances });
  return instance;
}

/**
 * Get the active DiscordJSReact instance.
 */
export function getDiscordUI(): DiscordJSReact | undefined {
  return instance;
}

/**
 * Render a React component to a Discord channel/thread.
 * Returns the renderer for lifecycle management.
 */
export function renderToChannel(channel: TextBasedChannel, content: ReactNode): void {
  if (!instance) {
    throw new Error("Discord UI not initialized — call initDiscordUI(client) first");
  }

  const renderer = instance.createRenderer(
    { type: "message", channel },
    content,
  );

  instance.activateRenderer(renderer);
}

/**
 * Shutdown — deactivate all renderers.
 */
export function shutdownDiscordUI(): void {
  if (instance) {
    for (const renderer of instance.renderers) {
      renderer.deactivate();
    }
    instance = undefined;
  }
  console.log("[discord-ui] shutdown");
}
