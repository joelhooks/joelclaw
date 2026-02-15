import type { MDXComponents } from "mdx/types";
import { CodeBlockCopyButton } from "../components/copy-button";

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

/** Extract plain text from nested React children */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (!children) return "";
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (typeof children === "object" && "props" in children) {
    return extractText(children.props.children);
  }
  return "";
}

export const mdxComponents: MDXComponents = {
  YouTube,
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
  a: (props) => (
    <a
      className="underline underline-offset-3 decoration-neutral-500 hover:decoration-neutral-300 transition-colors"
      {...props}
    />
  ),
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
  img: (props) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="max-w-full h-auto rounded-lg my-6" alt={props.alt ?? ""} {...props} />
  ),
};
