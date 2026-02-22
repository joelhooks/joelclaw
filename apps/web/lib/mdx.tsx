import type { MDXComponents } from "mdx/types";
import Image from "next/image";
import Link from "next/link";
import { CodeBlockCopyButton } from "../components/copy-button";

// ── Tufte-style sidenotes ──────────────────────────────────────
// Numbered sidenotes (superscript toggle) and unnumbered margin notes.
// Pure CSS toggle on mobile (checkbox hack, no JS). Desktop: floats into right margin.
// Credit: Edward Tufte / Tufte-CSS (https://edwardtufte.github.io/tufte-css/)

function Sidenote({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <span className="sidenote-wrapper">
      <label htmlFor={id} className="margin-toggle sidenote-number" />
      <input type="checkbox" id={id} className="margin-toggle" />
      <span className="sidenote">{children}</span>
    </span>
  );
}

function MarginNote({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <span className="sidenote-wrapper">
      <label htmlFor={id} className="margin-toggle">&#8853;</label>
      <input type="checkbox" id={id} className="margin-toggle" />
      <span className="marginnote">{children}</span>
    </span>
  );
}

/**
 * Agent-only content component.
 *
 * Build pipeline strips these blocks from human outputs.
 * This runtime fallback returns null for safety.
 */
function AgentOnly(_props: { children: React.ReactNode }) {
  return null;
}

/**
 * Backward-compatible alias for legacy content.
 */
function AgentNote(_props: { children: React.ReactNode }) {
  return null;
}

function YouTube({ id }: { id: string }) {
  return (
    <div className="my-6 aspect-video w-full overflow-hidden rounded-lg border border-neutral-800">
      <iframe
        src={`https://www.youtube.com/embed/${id}`}
        title="YouTube video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="h-full w-full"
      />
    </div>
  );
}

function extractYouTubeId(url: string): string | null {
  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function YouTubeEmbed({ url, videoId }: { url?: string; videoId?: string }) {
  const id = videoId ?? extractYouTubeId(url ?? "");
  if (!id) return null;

  return (
    <div className="my-8 aspect-video w-full overflow-hidden rounded-lg border border-neutral-800">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${id}`}
        className="h-full w-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        title="Video"
      />
    </div>
  );
}

/** Extract plain text from nested React children */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (!children) return "";
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

export const mdxComponents: MDXComponents = {
  AgentOnly,
  AgentNote,
  YouTube,
  YouTubeEmbed,
  Sidenote,
  MarginNote,
  h1: (props) => <h1 className="text-3xl font-bold mt-10 mb-4 tracking-tight" {...props} />,
  h2: (props) => (
    <h2
      className="text-2xl font-semibold mt-8 mb-3 tracking-tight group"
      {...props}
    />
  ),
  h3: (props) => (
    <h3 className="text-xl font-semibold mt-6 mb-2 group" {...props} />
  ),
  p: (props) => <p className="mb-5 leading-relaxed text-neutral-300" {...props} />,
  ul: (props) => <ul className="mb-5 pl-6 list-disc text-neutral-300" {...props} />,
  ol: (props) => <ol className="mb-5 pl-6 list-decimal text-neutral-300" {...props} />,
  li: (props) => <li className="mb-1 leading-relaxed" {...props} />,
  a: ({ href, ...props }) => {
    const isInternal = href && (href.startsWith("/") || href.startsWith("#"));
    if (isInternal) {
      return (
        <Link
          href={href}
          className="underline underline-offset-3 decoration-neutral-500 hover:decoration-neutral-300 transition-colors"
          {...props}
        />
      );
    }
    return (
      <a
        href={href}
        className="underline underline-offset-3 decoration-neutral-500 hover:decoration-neutral-300 transition-colors"
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      />
    );
  },
  blockquote: (props) => (
    <blockquote
      className="my-6 pl-5 border-l-2 border-neutral-700 text-neutral-400 italic"
      {...props}
    />
  ),
  // inline code only — rehype-pretty-code handles block code
  code: (props) => {
    // rehype-pretty-code adds data attributes to its code blocks
    const isPrettyCode =
      props["data-language"] || props["data-theme"];
    if (isPrettyCode) {
      return <code className="font-mono text-sm" {...props} />;
    }
    return (
      <code
        className="font-mono text-sm bg-neutral-800 px-1.5 py-0.5 rounded text-neutral-200"
        {...props}
      />
    );
  },
  // rehype-pretty-code wraps blocks in <figure data-rehype-pretty-code-figure>
  figure: (props) => {
    if (props["data-rehype-pretty-code-figure"] !== undefined) {
      const text = extractText(props.children);
      return (
        <figure className="group/code relative my-6 not-prose" {...props}>
          {props.children}
          <div className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity">
            <CodeBlockCopyButton text={text} />
          </div>
        </figure>
      );
    }
    return <figure {...props} />;
  },
  pre: (props) => (
    <pre
      className="p-4 bg-neutral-900 border border-neutral-800 rounded-lg overflow-x-auto text-sm leading-relaxed"
      {...props}
    />
  ),
  // GFM table support
  table: (props) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full text-sm text-left border-collapse" {...props} />
    </div>
  ),
  thead: (props) => (
    <thead className="border-b border-neutral-700 text-neutral-200" {...props} />
  ),
  th: (props) => <th className="py-2 px-3 font-semibold" {...props} />,
  tbody: (props) => <tbody className="text-neutral-300" {...props} />,
  tr: (props) => <tr className="border-b border-neutral-800" {...props} />,
  td: (props) => <td className="py-2 px-3" {...props} />,
  // GFM extras
  del: (props) => <del className="text-neutral-500" {...props} />,
  input: (props) => {
    // task list checkboxes
    if (props.type === "checkbox") {
      return (
        <input
          className="mr-2 accent-neutral-400"
          disabled
          {...props}
        />
      );
    }
    return <input {...props} />;
  },
  hr: () => <hr className="my-8 border-neutral-800" />,
  img: ({ src, alt, ...props }) => {
    if (!src) return null;
    return (
      <Image
        src={src}
        alt={alt ?? ""}
        width={1200}
        height={800}
        className="max-w-full h-auto rounded-lg my-6"
        sizes="(max-width: 768px) 100vw, 720px"
        {...props}
      />
    );
  },
};
