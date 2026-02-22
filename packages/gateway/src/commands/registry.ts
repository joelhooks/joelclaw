export type CommandCategory = "session" | "ops" | "search" | "tools" | "options" | "meta";

export type CommandArgChoice = string | { value: string; label: string };

export type CommandArgDefinition = {
  name: string;
  description: string;
  type: "string" | "number";
  required?: boolean;
  choices?: CommandArgChoice[];
  captureRemaining?: boolean;
};

export type ArgsMenuDefinition = "auto" | { arg: string; title?: string };

export type ParsedArgs = {
  raw: string;
  positional: string[];
  values: Record<string, string | number>;
};

export type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type DirectCommandResult =
  | string
  | {
      html: string;
      replyMarkup?: InlineKeyboardMarkup;
    };

export type CommandDefinition = {
  key: string;
  nativeName: string;
  description: string;
  category: CommandCategory;
  execution: "direct" | "light" | "agent";
  hidden?: boolean;
  args?: CommandArgDefinition[];
  argsMenu?: ArgsMenuDefinition;
  directHandler?: (args: ParsedArgs) => Promise<DirectCommandResult>;
  lightModel?: "haiku" | "sonnet";
  inngestEvent?: string;
};

const commandRegistry = new Map<string, CommandDefinition>();

export function defineChatCommand(definition: CommandDefinition): CommandDefinition {
  return Object.freeze({ ...definition });
}

export function registerCommands(commands: CommandDefinition[]): void {
  for (const command of commands) {
    commandRegistry.set(command.nativeName, command);
  }
}

export function getCommands(): CommandDefinition[] {
  return Array.from(commandRegistry.values()).filter((command) => !command.hidden);
}

export function getAllCommands(): CommandDefinition[] {
  return Array.from(commandRegistry.values());
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commandRegistry.get(name.replace(/^\//, ""));
}

export { commandRegistry };
