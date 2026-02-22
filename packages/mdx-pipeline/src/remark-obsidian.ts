import type { Image, Link, Root, Text } from "mdast";
import { SKIP, visit } from "unist-util-visit";

const WIKILINK_PATTERN = /(!)?\[\[([^[\]]+)\]\]/g;
const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif",
]);

function splitTargetAndAlias(value: string): { target: string; alias?: string } {
  const pipeIndex = value.indexOf("|");
  if (pipeIndex === -1) return { target: value.trim() };
  return {
    target: value.slice(0, pipeIndex).trim(),
    alias: value.slice(pipeIndex + 1).trim(),
  };
}

function stripMarkdownExtension(value: string): string {
  return value.replace(/\.mdx?$/i, "");
}

function isImagePath(target: string): boolean {
  const ext = target.split(".").pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

export interface RemarkObsidianOptions {
  /** How to resolve a wikilink target to an href. Default: /adrs/{target} */
  resolveLink?: (target: string, alias?: string) => string;
  /** How to resolve an image embed to a src. Default: /images/{target} */
  resolveImage?: (target: string) => string;
}

/**
 * Convert Obsidian wikilinks/embeds to standard markdown nodes.
 * Configurable link/image resolution for different contexts (blog vs vault).
 */
export function remarkObsidian(options: RemarkObsidianOptions = {}) {
  const resolveLink = options.resolveLink ?? ((target) => {
    const normalized = stripMarkdownExtension(target).replace(/\\/g, "/").replace(/^\.?\//, "").trim();
    return `/adrs/${encodeURI(normalized)}`;
  });

  const resolveImage = options.resolveImage ?? ((target) => {
    const normalized = stripMarkdownExtension(target).replace(/\\/g, "/").replace(/^\.?\//, "").trim();
    return `/images/${encodeURI(normalized)}`;
  });

  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      if (parent.type === "link") return;

      const source = node.value;
      if (!source.includes("[[")) return;

      WIKILINK_PATTERN.lastIndex = 0;
      let lastIndex = 0;
      let matched = false;
      let match: RegExpExecArray | null;
      const replacementNodes: Array<Text | Link | Image> = [];

      while ((match = WIKILINK_PATTERN.exec(source)) !== null) {
        const isEmbed = Boolean(match[1]);
        const rawInner = match[2];
        if (!rawInner) continue;
        matched = true;

        if (match.index > lastIndex) {
          replacementNodes.push({ type: "text", value: source.slice(lastIndex, match.index) });
        }

        const { target, alias } = splitTargetAndAlias(rawInner);
        const cleanTarget = stripMarkdownExtension(target).trim();

        if (!cleanTarget) {
          replacementNodes.push({ type: "text", value: match[0] });
          lastIndex = match.index + match[0].length;
          continue;
        }

        if (isEmbed && isImagePath(cleanTarget)) {
          replacementNodes.push({
            type: "image",
            url: resolveImage(cleanTarget),
            alt: alias || cleanTarget.split("/").pop() || cleanTarget,
          });
        } else {
          const label = alias || cleanTarget;
          replacementNodes.push({
            type: "link",
            url: resolveLink(cleanTarget, alias),
            children: [{ type: "text", value: label }],
          });
        }

        lastIndex = match.index + match[0].length;
      }

      if (!matched) return;

      if (lastIndex < source.length) {
        replacementNodes.push({ type: "text", value: source.slice(lastIndex) });
      }

      parent.children.splice(index, 1, ...replacementNodes);
      return [SKIP, index + replacementNodes.length];
    });
  };
}
