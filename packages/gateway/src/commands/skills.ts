import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CommandDefinition,
  defineChatCommand,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type ParsedArgs,
} from "./registry";

type SkillDefinition = {
  name: string;
  description: string;
  commandName: string;
};

type LoadedSkillCommands = {
  skills: SkillDefinition[];
  commands: CommandDefinition[];
};

const SKILLS_ROOT = path.join(os.homedir(), ".pi", "agent", "skills");
const SKILL_PAGE_SIZE = 30;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function normalizeSkillToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseMultilineYamlValue(block: string, key: string): string | undefined {
  // Match single-line: `key: "value"` or `key: value`
  const singleLine = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (singleLine?.[1]) {
    const raw = singleLine[1].trim();
    // Not a multiline indicator — return as-is
    if (raw !== ">" && raw !== ">-" && raw !== "|" && raw !== "|-") {
      return unquote(raw);
    }
  }

  // Match multiline block scalar: `key: >-\n  line1\n  line2\n`
  // Captures all subsequent indented lines until a non-indented line or end
  const multiLine = block.match(new RegExp(`^${key}:\\s*[>|]-?\\s*\\r?\\n((?:[ \\t]+.+(?:\\r?\\n|$))+)`, "m"));
  if (multiLine?.[1]) {
    return multiLine[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  }

  return undefined;
}

function parseFrontmatter(markdown: string): { name?: string; description?: string } {
  const frontmatterMatch = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const block = frontmatterMatch?.[1];
  if (!block) return {};

  return {
    name: parseMultilineYamlValue(block, "name"),
    description: parseMultilineYamlValue(block, "description"),
  };
}

function skillEmoji(skillName: string, description: string): string {
  const haystack = `${skillName} ${description}`.toLowerCase();

  if (haystack.includes("email") || haystack.includes("mail")) return "📧";
  if (haystack.includes("video")) return "📹";
  if (haystack.includes("task")) return "📋";
  if (haystack.includes("recall") || haystack.includes("memory")) return "🧠";
  if (haystack.includes("message") || haystack.includes("imsg")) return "💬";
  if (haystack.includes("book") || haystack.includes("pdf")) return "📚";
  if (haystack.includes("k8s") || haystack.includes("docker")) return "⚙️";
  if (haystack.includes("pds") || haystack.includes("atproto")) return "🔐";
  if (haystack.includes("browser")) return "🌐";
  if (haystack.includes("code") || haystack.includes("build")) return "🔨";
  if (haystack.includes("search") || haystack.includes("defuddle")) return "🔍";
  if (haystack.includes("gateway")) return "🚪";
  if (haystack.includes("webhook")) return "🔗";

  return "🔧";
}

function skillsKeyboard(skills: SkillDefinition[], page: number): InlineKeyboardMarkup {
  const pageCount = Math.max(1, Math.ceil(skills.length / SKILL_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * SKILL_PAGE_SIZE;
  const pageSkills = skills.slice(start, start + SKILL_PAGE_SIZE);

  const rows: InlineKeyboardButton[][] = [];

  for (let i = 0; i < pageSkills.length; i += 2) {
    const row = pageSkills.slice(i, i + 2).map((skill) => ({
      text: `${skillEmoji(skill.name, skill.description)} ${skill.name}`,
      callback_data: `cmd:${skill.commandName}:`,
    }));
    rows.push(row);
  }

  if (skills.length > SKILL_PAGE_SIZE) {
    const navRow: InlineKeyboardButton[] = [];

    if (safePage > 1) {
      navRow.push({
        text: "◀ Prev",
        callback_data: `cmd:skills:${safePage - 1}`,
      });
    }

    if (safePage < pageCount) {
      navRow.push({
        text: "Next ▶",
        callback_data: `cmd:skills:${safePage + 1}`,
      });
    }

    if (navRow.length > 0) rows.push(navRow);
  }

  return { inline_keyboard: rows };
}

function parsePageArg(parsed: ParsedArgs): number {
  const explicit = parsed.values.page;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(1, Math.floor(explicit));
  }

  const first = parsed.positional[0];
  if (!first) return 1;

  const parsedPage = Number.parseInt(first, 10);
  if (Number.isNaN(parsedPage)) return 1;
  return Math.max(1, parsedPage);
}

export async function loadSkillCommands(): Promise<LoadedSkillCommands> {
  const loadedSkills: SkillDefinition[] = [];
  const commands: CommandDefinition[] = [];
  const seen = new Set<string>();

  try {
    const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });

    for (const entry of entries) {
      // Follow symlinks — most skills are symlinked into the skills directory
      const entryPath = path.join(SKILLS_ROOT, entry.name);
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          const resolved = await stat(entryPath);
          isDir = resolved.isDirectory();
        } catch {
          // Broken symlink
        }
      }
      if (!isDir) continue;

      const skillPath = path.join(entryPath, "SKILL.md");

      try {
        const markdown = await readFile(skillPath, "utf8");
        const frontmatter = parseFrontmatter(markdown);

        const skillName = frontmatter.name?.trim() || entry.name;
        const description = frontmatter.description?.trim() || `Run ${skillName}`;
        const token = normalizeSkillToken(skillName || entry.name);
        if (!token) continue;

        const commandName = `skill_${token}`;
        if (seen.has(commandName)) continue;
        seen.add(commandName);

        loadedSkills.push({
          name: skillName,
          description,
          commandName,
        });

        commands.push(defineChatCommand({
          key: commandName,
          nativeName: commandName,
          description: truncate(description, 80),
          category: "tools",
          execution: "agent",
          hidden: true,
        }));
      } catch {
        // Ignore unreadable or malformed skills; load what we can.
      }
    }
  } catch {
    // Skills directory can be absent; this should not break startup.
  }

  loadedSkills.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`[gateway] loaded ${commands.length} skill commands`);
  return { skills: loadedSkills, commands };
}

export function createSkillsMenuCommand(skills: SkillDefinition[]): CommandDefinition {
  return defineChatCommand({
    key: "skills",
    nativeName: "skills",
    description: "Browse and run available skills",
    category: "tools",
    execution: "direct",
    args: [
      {
        name: "page",
        description: "Optional page number",
        type: "number",
      },
    ],
    directHandler: async (parsed) => {
      const pageCount = Math.max(1, Math.ceil(skills.length / SKILL_PAGE_SIZE));
      const page = Math.min(parsePageArg(parsed), pageCount);
      const keyboard = skillsKeyboard(skills, page);

      const html = skills.length === 0
        ? "<b>No skills found</b>"
        : `<b>Available skills</b>\nPage <code>${page}</code>/<code>${pageCount}</code>`;

      return {
        html,
        replyMarkup: keyboard,
      };
    },
  });
}
