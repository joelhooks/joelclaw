import { visit } from "unist-util-visit";
import { LANGUAGE_ALIASES } from "./config";

/**
 * Normalize common fenced-code language aliases before Shiki runs.
 * Keeps highlighting deterministic even when authors use shorthand tags.
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
