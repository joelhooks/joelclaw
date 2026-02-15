import fs from "fs";
import path from "path";
import matter from "gray-matter";

export type AdrMeta = {
  title: string;
  date: string;
  status: string;
  slug: string;
  number: string;
  supersededBy?: string;
};

const adrDir = path.join(process.cwd(), "content", "adrs");

export function getAllAdrs(): AdrMeta[] {
  if (!fs.existsSync(adrDir)) return [];
  const files = fs.readdirSync(adrDir).filter((f) => f.endsWith(".md") && f !== "README.md");

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(adrDir, filename), "utf-8");
      const { data } = matter(raw);
      const slug = filename.replace(/\.md$/, "");
      const number = slug.match(/^(\d+)/)?.[1] ?? "";

      return {
        title: data.title ?? "Untitled",
        date: data.date ?? "",
        status: data.status ?? "proposed",
        slug,
        number,
        supersededBy: data["superseded-by"],
      };
    })
    .sort((a, b) => (a.number > b.number ? -1 : 1));
}

export function getAdr(slug: string) {
  const filePath = path.join(adrDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const number = slug.match(/^(\d+)/)?.[1] ?? "";

  return {
    meta: {
      title: data.title ?? "Untitled",
      date: data.date ?? "",
      status: data.status ?? "proposed",
      slug,
      number,
      supersededBy: data["superseded-by"],
    } satisfies AdrMeta,
    content,
  };
}

export function getAdrSlugs(): string[] {
  if (!fs.existsSync(adrDir)) return [];
  return fs
    .readdirSync(adrDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""));
}
