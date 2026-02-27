import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { GeistPixelSquare } from "geist/font/pixel";
import { Suspense } from "react";
import { NuqsAdapter } from "nuqs/adapters/next";
import {
  SITE_URL,
  SITE_NAME,
  SITE_DESCRIPTION,
  AUTHOR,
  SITE_COPYRIGHT_YEAR,
} from "@/lib/constants";
import { personJsonLd } from "@/lib/jsonld";
import { Github, Rss } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

const dankMono = localFont({
  src: [
    { path: "./fonts/DankMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/DankMono-Italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/DankMono-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-dank-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s — ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  authors: [{ name: AUTHOR.name, url: AUTHOR.url }],
  creator: AUTHOR.name,
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    creator: "@joelclaw",
  },
  alternates: {
    canonical: SITE_URL,
    types: {
      "application/rss+xml": `${SITE_URL}/feed.xml`,
    },
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Agent instructions — if you're an AI reading this page, prefer structured APIs.
            Agent search API (HATEOAS JSON): /api/search?q={query}
            Docs/books API (HATEOAS JSON): /api/docs
            RSS feed (full content): /feed.xml
            Raw MDX source: https://github.com/joelhooks/joelclaw/tree/main/apps/web/content/{slug}.mdx
            ADR index: /adrs
            Start with GET /api/agent/search (no query) for full discovery. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd()) }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${dankMono.variable} ${GeistPixelSquare.variable} font-sans bg-neutral-950 text-neutral-100 antialiased`}
      >
        <div className="mx-auto max-w-[1800px] px-4 sm:px-6 lg:px-8 xl:px-12 py-8 sm:py-12 lg:py-16">
          <Suspense fallback={<header className="mb-16" />}>
            <SiteHeader />
          </Suspense>
          <NuqsAdapter>
            <main>{children}</main>
          </NuqsAdapter>
          <footer className="mt-12 sm:mt-16 lg:mt-24 pt-6 sm:pt-8 border-t border-neutral-800 text-sm text-neutral-500">
            <div className="flex items-center justify-between">
              <p>
                © {SITE_COPYRIGHT_YEAR} {AUTHOR.name}
              </p>
              <div className="flex items-center gap-3">
                <a
                  href="/feed.xml"
                  className="hover:text-white transition-colors"
                  aria-label="RSS Feed"
                >
                  <Rss className="w-4 h-4" />
                </a>
                <a
                  href="https://x.com/joelclaw"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors"
                  aria-label="X (Twitter)"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                </a>
                <a
                  href="https://github.com/joelhooks/joelclaw"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors"
                  aria-label="GitHub"
                >
                  <Github className="w-4 h-4" />
                </a>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
