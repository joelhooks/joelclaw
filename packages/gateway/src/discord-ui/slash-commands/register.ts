import { type Client, SlashCommandBuilder } from "discord.js";
import { ALLOWED_MODELS, ALLOWED_THINKING_LEVELS } from "../../commands/config";

export const DISCORD_SLASH_COMMANDS = [
  new SlashCommandBuilder().setName("status").setDescription("System health summary"),
  new SlashCommandBuilder().setName("health").setDescription("Detailed gateway health"),
  new SlashCommandBuilder()
    .setName("runs")
    .setDescription("Recent runs")
    .addIntegerOption((option) => option.setName("count").setDescription("Number of runs").setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search system knowledge")
    .addStringOption((option) => option.setName("query").setDescription("Search query").setRequired(true)),
  new SlashCommandBuilder()
    .setName("recall")
    .setDescription("Recall from memory")
    .addStringOption((option) => option.setName("query").setDescription("Recall query").setRequired(true)),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Set gateway model")
    .addStringOption((option) => {
      const next = option
        .setName("model")
        .setDescription("Configured model")
        .setRequired(true);
      for (const model of ALLOWED_MODELS) {
        next.addChoices({ name: model, value: model });
      }
      return next;
    }),
  new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Set thinking level")
    .addStringOption((option) => {
      const next = option
        .setName("level")
        .setDescription("Thinking level")
        .setRequired(true);
      for (const level of ALLOWED_THINKING_LEVELS) {
        next.addChoices({ name: level, value: level });
      }
      return next;
    }),
  new SlashCommandBuilder().setName("compact").setDescription("Compact the current session"),
  new SlashCommandBuilder().setName("new").setDescription("Start a new session"),
  new SlashCommandBuilder().setName("reload").setDescription("Reload extensions and prompts"),
  new SlashCommandBuilder()
    .setName("fork")
    .setDescription("Fork from a message")
    .addStringOption((option) => option.setName("message_id").setDescription("Optional message ID to fork from")),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Queue a follow-up prompt")
    .addStringOption((option) => option.setName("prompt").setDescription("Prompt to enqueue").setRequired(true)),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume a previous session")
    .addStringOption((option) => option.setName("session").setDescription("Optional session ID")),
  new SlashCommandBuilder().setName("abort").setDescription("Abort current operation"),
].map((command) => command.toJSON());

export type SlashRegistrationResult = {
  attemptedGuilds: number;
  registeredGuilds: number;
  commandCount: number;
  failures: Array<{ guildId: string; error: string }>;
};

export async function registerDiscordSlashCommands(client: Client): Promise<SlashRegistrationResult> {
  const app = client.application;
  if (!app) {
    return {
      attemptedGuilds: 0,
      registeredGuilds: 0,
      commandCount: DISCORD_SLASH_COMMANDS.length,
      failures: [{ guildId: "n/a", error: "client.application unavailable" }],
    };
  }

  const configuredGuildId = process.env.DISCORD_GUILD_ID?.trim();
  const guildIds = configuredGuildId
    ? [configuredGuildId]
    : Array.from((await client.guilds.fetch()).keys());

  const failures: Array<{ guildId: string; error: string }> = [];
  let registeredGuilds = 0;

  for (const guildId of guildIds) {
    try {
      await app.commands.set(DISCORD_SLASH_COMMANDS, guildId);
      registeredGuilds += 1;
    } catch (error) {
      failures.push({ guildId, error: String(error) });
    }
  }

  return {
    attemptedGuilds: guildIds.length,
    registeredGuilds,
    commandCount: DISCORD_SLASH_COMMANDS.length,
    failures,
  };
}
