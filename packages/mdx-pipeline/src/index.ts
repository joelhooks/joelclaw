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
export { LANGUAGE_ALIASES, prettyCodeOptions, SHIKI_LANGS, SHIKI_THEME } from "./config";

// Plugins
export { getRemarkPlugins, rehypePlugins } from "./plugins";
export { rehypeNormalizeCodeLangs } from "./rehype-normalize-code-langs";
export { rehypeParagraphIds } from "./rehype-paragraph-ids";
// Individual plugins (for custom pipelines)
export { type RemarkObsidianOptions, remarkObsidian } from "./remark-obsidian";
export { remarkStripAgentOnly } from "./remark-strip-agent-only";

// Standalone renderer
export { renderMarkdown } from "./render";
