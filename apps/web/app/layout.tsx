import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, AUTHOR } from "../lib/constants";
import { personJsonLd } from "../lib/jsonld";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
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
        className={`${geistSans.variable} ${geistMono.variable} font-sans bg-neutral-950 text-neutral-100 antialiased`}
      >
        <div className="mx-auto max-w-2xl px-6 py-16">
          <header className="mb-16">
            <Link href="/" className="text-lg font-semibold hover:text-white transition-colors">
              {SITE_NAME}
            </Link>
          </header>
          <main>{children}</main>
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
