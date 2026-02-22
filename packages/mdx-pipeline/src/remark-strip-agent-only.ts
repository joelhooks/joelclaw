import type { Root } from "mdast";
import { SKIP, visit } from "unist-util-visit";

type NodeWithName = { type?: string; name?: string };

const AGENT_ONLY_TAGS = new Set(["AgentOnly", "AgentNote"]);

/**
 * Removes agent-only MDX JSX blocks from the tree.
 * Used for human-facing outputs (HTML and .md).
 */
export function remarkStripAgentOnly() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (index === undefined || !parent) return;
      const typedNode = node as NodeWithName;
      const isMdxJsxNode =
        typedNode.type === "mdxJsxFlowElement" || typedNode.type === "mdxJsxTextElement";
      if (!isMdxJsxNode) return;
      if (!typedNode.name || !AGENT_ONLY_TAGS.has(typedNode.name)) return;
      parent.children.splice(index, 1);
      return [SKIP, index];
    });
  };
}
