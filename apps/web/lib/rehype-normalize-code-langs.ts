import { visit } from "unist-util-visit";

const LANGUAGE_ALIASES: Record<string, string> = {
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

/**
 * Normalize common fenced-code language aliases before Shiki runs.
 * This keeps highlighting deterministic even when authors use shorthand tags.
 */
export function rehypeNormalizeCodeLangs() {
  return (tree: unknown) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "code") return;
      const className = node.properties?.className;
      if (!Array.isArray(className)) return;

      const langClassIndex = className.findIndex(
        (value) => typeof value === "string" && value.startsWith("language-"),
      );
      if (langClassIndex === -1) return;

      const langClass = className[langClassIndex] as string;
      const rawLang = langClass.slice("language-".length).toLowerCase();
      const normalizedLang = LANGUAGE_ALIASES[rawLang] ?? rawLang;
      className[langClassIndex] = `language-${normalizedLang}`;
      node.properties.className = className;
    });
  };
}
