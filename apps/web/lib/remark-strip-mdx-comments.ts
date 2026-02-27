import type { Root } from "mdast";
import { SKIP, visit } from "unist-util-visit";

/**
 * Remark plugin that strips MDX expression comments: {/* ... *​/}
 *
 * These show up as mdxFlowExpression or mdxTextExpression nodes
 * when using MDX parsing, or as raw HTML comments in plain markdown.
 * For the /md route we strip them entirely.
 */
export function remarkStripMdxComments() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (index === undefined || !parent) return;

      // MDX expression nodes (from mdx parser)
      if (
        (node.type === "mdxFlowExpression" ||
          node.type === "mdxTextExpression") &&
        "value" in node &&
        typeof node.value === "string" &&
        node.value.trimStart().startsWith("/*")
      ) {
        parent.children.splice(index, 1);
        return [SKIP, index];
      }
    });
  };
}
