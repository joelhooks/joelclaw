import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { NuqsAdapter } from "nuqs/adapters/next";
import { SITE_URL, SITE_NAME, SITE_TAGLINE, SITE_DESCRIPTION, AUTHOR } from "../lib/constants";
import { personJsonLd } from "../lib/jsonld";
import { CLAW_PATH } from "../lib/claw";
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
    creator: "@jhooks",
  },
  alternates: {
    canonical: SITE_URL,
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd()) }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${dankMono.variable} font-sans bg-neutral-950 text-neutral-100 antialiased`}
      >
        <div className="mx-auto max-w-2xl px-6 py-16">
          <header className="mb-16">
            <div className="flex items-center justify-between">
              <Link href="/" className="group flex items-center gap-3">
                <svg viewBox="0 0 512 512" className="w-8 h-8 shrink-0 text-claw transition-transform group-hover:rotate-[-8deg]" aria-hidden="true">
                  <path fill="currentColor" d={CLAW_PATH} />
                </svg>
                <div>
                  <span className="text-lg font-semibold group-hover:text-white transition-colors">
                    {SITE_NAME}
                  </span>
                  <span className="hidden sm:block text-sm text-neutral-500 mt-0.5">
                    {SITE_TAGLINE}
                  </span>
                </div>
              </Link>
              <nav className="flex items-center gap-5 text-sm text-neutral-500">
                <Link href="/" className="hover:text-white transition-colors">
                  Writing
                </Link>
                <Link href="/adrs" className="hover:text-white transition-colors">
                  ADRs
                </Link>
              </nav>
            </div>
          </header>
          <NuqsAdapter>
            <main>{children}</main>
          </NuqsAdapter>
          <footer className="mt-24 pt-8 border-t border-neutral-800 text-sm text-neutral-500">
            <p>
              © {new Date().getFullYear()} {AUTHOR.name}
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
