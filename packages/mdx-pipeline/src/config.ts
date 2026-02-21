/**
 * Shared MDX/markdown rendering configuration.
 * Single source of truth for theme, languages, and plugin options.
 */
import type { Options as PrettyCodeOptions } from "rehype-pretty-code";
import { getSingletonHighlighter } from "shiki";

export const SHIKI_THEME = "catppuccin-macchiato";

export const SHIKI_LANGS = [
  "plaintext",
  "bash",
  "python",
  "yaml",
  "typescript",
  "javascript",
  "json",
  "markdown",
  "graphql",
  "swift",
] as const;

export const prettyCodeOptions: PrettyCodeOptions = {
  theme: {
    dark: SHIKI_THEME,
    light: SHIKI_THEME,
  },
  grid: true,
  keepBackground: true,
  defaultLang: {
    block: "plaintext",
    inline: "plaintext",
  },
  getHighlighter: async (options) =>
    getSingletonHighlighter({
      ...options,
      themes: [SHIKI_THEME],
      langs: [...SHIKI_LANGS],
    }),
};

/** Language aliases for code fence normalization */
export const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  yml: "yaml",
  ts: "typescript",
  js: "javascript",
  py: "python",
  md: "markdown",
  gql: "graphql",
};
