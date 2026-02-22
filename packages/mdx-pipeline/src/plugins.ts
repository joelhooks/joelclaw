/**
 * Assembled remark/rehype plugin arrays.
 * Import these directly into MDX config or content-collections setup.
 */
import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeExternalLinks from "rehype-external-links";
import rehypeUnwrapImages from "rehype-unwrap-images";

import { prettyCodeOptions } from "./config";
import { rehypeNormalizeCodeLangs } from "./rehype-normalize-code-langs";
import { rehypeParagraphIds } from "./rehype-paragraph-ids";
import { remarkObsidian, type RemarkObsidianOptions } from "./remark-obsidian";
import { remarkStripAgentOnly } from "./remark-strip-agent-only";

/**
 * Standard remark plugins for joelclaw content.
 * Pass obsidianOptions to customize wikilink resolution.
 */
export function getRemarkPlugins(obsidianOptions?: RemarkObsidianOptions): any[] {
  return [
    remarkGfm,
    [remarkObsidian, obsidianOptions || {}],
    remarkStripAgentOnly,
    remarkSmartypants,
  ];
}

/** Standard rehype plugins for joelclaw content. */
export const rehypePlugins: any[] = [
  rehypeSlug,
  rehypeParagraphIds,
  [rehypeAutolinkHeadings, { behavior: "wrap" }],
  rehypeNormalizeCodeLangs,
  [rehypePrettyCode, prettyCodeOptions],
  [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }],
  rehypeUnwrapImages,
];
