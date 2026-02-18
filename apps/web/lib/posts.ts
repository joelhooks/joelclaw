import fs from "fs";
import path from "path";
import matter from "gray-matter";

export type ContentType = "article" | "note" | "tutorial";

export type PostMeta = {
  title: string;
  date: string;
  updated?: string;
  description: string;
  slug: string;
  type: ContentType;
  source?: string;
  channel?: string;
  duration?: string;
  draft?: boolean;
};

const contentDir = path.join(process.cwd(), "content");

export function getAllPosts(): PostMeta[] {
  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(contentDir, filename), "utf-8");
      const { data } = matter(raw);

      return {
        title: data.title ?? "Untitled",
        date: data.date ?? "",
        updated: data.updated,
        description: data.description ?? "",
        slug: filename.replace(/\.mdx$/, ""),
        type: (data.type as ContentType) ?? "article",
        source: data.source,
        channel: data.channel,
        duration: data.duration,
        draft: data.draft ?? false,
      };
    })
    .filter((post) => process.env.NODE_ENV === "development" || !post.draft)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function getPost(slug: string) {
  const filePath = path.join(contentDir, `${slug}.mdx`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  return {
    meta: {
      title: data.title ?? "Untitled",
      date: data.date ?? "",
      updated: data.updated,
      description: data.description ?? "",
      slug,
      type: (data.type as ContentType) ?? "article",
      source: data.source,
      channel: data.channel,
      duration: data.duration,
      draft: data.draft ?? false,
    } satisfies PostMeta,
    content,
  };
}

export function getPostSlugs(): string[] {
  return fs
    .readdirSync(contentDir)
    .filter((f) => f.endsWith(".mdx"))
    .filter((f) => {
      if (process.env.NODE_ENV === "development") return true;
      const raw = fs.readFileSync(path.join(contentDir, f), "utf-8");
      const { data } = matter(raw);
      return !data.draft;
    })
    .map((f) => f.replace(/\.mdx$/, ""));
}
