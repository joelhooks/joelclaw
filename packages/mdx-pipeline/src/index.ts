/**
 * @joelclaw/mdx-pipeline — shared markdown/MDX rendering pipeline.
 *
 * Single source of truth for remark/rehype plugins, Shiki config,
 * and Obsidian-flavored markdown features across joelclaw.com.
 *
 * Used by:
 * - apps/web (blog MDX rendering)
 * - packages/system-bus (vault note pre-rendering)
 */

// Config
export { SHIKI_THEME, SHIKI_LANGS, prettyCodeOptions, LANGUAGE_ALIASES } from "./config";

// Plugins
export { getRemarkPlugins, rehypePlugins } from "./plugins";

// Individual plugins (for custom pipelines)
export { remarkObsidian, type RemarkObsidianOptions } from "./remark-obsidian";
export { remarkStripAgentOnly } from "./remark-strip-agent-only";
export { rehypeNormalizeCodeLangs } from "./rehype-normalize-code-langs";
export { rehypeParagraphIds } from "./rehype-paragraph-ids";

// Standalone renderer
export { renderMarkdown } from "./render";
