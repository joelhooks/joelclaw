import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { MdastRoot } from "./types";

export function parseMd(md: string): MdastRoot {
  const ast = unified().use(remarkParse).use(remarkGfm).parse(md);
  const root = unified().use(remarkParse).use(remarkGfm).runSync(ast);
  return root as MdastRoot;
}
