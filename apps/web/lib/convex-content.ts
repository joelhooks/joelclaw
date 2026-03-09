import { type AdrMeta, getAdr, getAdrSlugs } from "@/lib/adrs";
import { getPost, getPostSlugs, type PostMeta } from "@/lib/posts";

export async function getAdrFromConvex(slug: string) {
  return getAdr(slug);
}

export async function getPostFromConvex(slug: string) {
  return getPost(slug);
}

export async function getAdrSlugsFromConvex(): Promise<string[]> {
  return getAdrSlugs();
}

export async function getPostSlugsFromConvex(): Promise<string[]> {
  return getPostSlugs();
}
