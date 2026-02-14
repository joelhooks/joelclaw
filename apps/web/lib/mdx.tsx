import type { MDXComponents } from "mdx/types";

export const mdxComponents: MDXComponents = {
  h1: (props) => <h1 className="text-3xl font-bold mt-10 mb-4 tracking-tight" {...props} />,
  h2: (props) => <h2 className="text-2xl font-semibold mt-8 mb-3 tracking-tight" {...props} />,
  h3: (props) => <h3 className="text-xl font-semibold mt-6 mb-2" {...props} />,
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
  code: (props) => {
    const isBlock = props.className?.startsWith("language-");
    if (isBlock) {
      return <code className="font-mono text-sm" {...props} />;
    }
    return <code className="font-mono text-sm bg-neutral-800 px-1.5 py-0.5 rounded" {...props} />;
  },
  pre: (props) => (
    <pre
      className="my-6 p-4 bg-neutral-900 border border-neutral-800 rounded-lg overflow-x-auto text-sm leading-relaxed"
      {...props}
    />
  ),
  hr: () => <hr className="my-8 border-neutral-800" />,
  img: (props) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="max-w-full h-auto rounded-lg my-6" alt={props.alt ?? ""} {...props} />
  ),
};
