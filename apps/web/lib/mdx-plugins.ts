import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeExternalLinks from "rehype-external-links";
import rehypeUnwrapImages from "rehype-unwrap-images";
import type { Options as PrettyCodeOptions } from "rehype-pretty-code";
import { getSingletonHighlighter } from "shiki";
import { rehypeNormalizeCodeLangs } from "./rehype-normalize-code-langs";
import { remarkObsidian } from "./remark-obsidian";
import { remarkStripAgentOnly } from "./remark-strip-agent-only";

const SHIKI_THEME = "catppuccin-macchiato";

const SHIKI_LANGS = [
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

const prettyCodeOptions: PrettyCodeOptions = {
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

export const remarkPlugins: any[] = [
  remarkGfm, // tables, strikethrough, autolinks, task lists
  remarkObsidian, // Obsidian wikilinks/embeds -> standard markdown links/images
  remarkStripAgentOnly, // strip <AgentOnly> blocks from human HTML
  remarkSmartypants, // smart quotes, em dashes, ellipses
];

export const rehypePlugins: any[] = [
  rehypeSlug, // id attributes on headings
  [rehypeAutolinkHeadings, { behavior: "wrap" }], // clickable heading links
  rehypeNormalizeCodeLangs, // normalize language aliases like sh/zsh/yml/ts/py
  [rehypePrettyCode, prettyCodeOptions], // shiki syntax highlighting
  [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }], // external link handling
  rehypeUnwrapImages, // remove <p> wrapper around images
];
