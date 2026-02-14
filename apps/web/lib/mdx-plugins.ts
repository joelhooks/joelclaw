import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeExternalLinks from "rehype-external-links";
import rehypeUnwrapImages from "rehype-unwrap-images";
import type { Options as PrettyCodeOptions } from "rehype-pretty-code";

const prettyCodeOptions: PrettyCodeOptions = {
  theme: {
    dark: "github-dark-default",
    light: "github-dark-default",
  },
  keepBackground: true,
  defaultLang: {
    block: "text",
  },
};

export const remarkPlugins: any[] = [
  remarkGfm, // tables, strikethrough, autolinks, task lists
  remarkSmartypants, // smart quotes, em dashes, ellipses
];

export const rehypePlugins: any[] = [
  rehypeSlug, // id attributes on headings
  [rehypeAutolinkHeadings, { behavior: "wrap" }], // clickable heading links
  [rehypePrettyCode, prettyCodeOptions], // shiki syntax highlighting
  [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }], // external link handling
  rehypeUnwrapImages, // remove <p> wrapper around images
];
