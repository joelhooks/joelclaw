import type { PostMeta } from "./posts";
import { SITE_URL, SITE_NAME, AUTHOR } from "./constants";

export function blogPostingJsonLd(meta: PostMeta) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: meta.title,
    description: meta.description,
    datePublished: meta.date,
    dateModified: meta.date,
    url: `${SITE_URL}/${meta.slug}`,
    author: {
      "@type": "Person",
      name: AUTHOR.name,
      url: AUTHOR.url,
    },
    publisher: {
      "@type": "Person",
      name: AUTHOR.name,
      url: AUTHOR.url,
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${SITE_URL}/${meta.slug}`,
    },
    isPartOf: {
      "@type": "Blog",
      name: SITE_NAME,
      url: SITE_URL,
    },
  };
}

export function blogJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: SITE_NAME,
    description:
      "Building a personal AI operating system from scratch. Architecture decisions, working code, and the journey from zero to a composable agent system.",
    url: SITE_URL,
    author: {
      "@type": "Person",
      name: AUTHOR.name,
      url: AUTHOR.url,
    },
  };
}

export function personJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: AUTHOR.name,
    url: AUTHOR.url,
    sameAs: ["https://github.com/joelhooks", "https://twitter.com/jhooks"],
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
