/**
 * MDX plugin configuration for joelclaw.com blog posts.
 * Imports from shared @joelclaw/mdx-pipeline package.
 */
import { getRemarkPlugins, rehypePlugins } from "@joelclaw/mdx-pipeline";

// Blog uses default obsidian options: wikilinks → /adrs/, images → /images/
export const remarkPlugins = getRemarkPlugins();
export { rehypePlugins };
