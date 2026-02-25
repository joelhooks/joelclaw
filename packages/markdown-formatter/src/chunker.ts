export function chunkByNodes<T>(nodes: T[], renderFn: (node: T) => string, maxLength: number): string[] {
  const renderedNodes = nodes.map(renderFn).filter((chunk) => chunk.length > 0);

  if (!renderedNodes.length) {
    return [];
  }

  const chunks: string[] = [];
  let current = "";

  function splitCodeBlockChunk(html: string): string[] {
    const match = html.match(/^<pre><code([^>]*)>([\s\S]*)<\/code><\/pre>$/);
    if (!match) return [html];
    const open = `<pre><code${match[1]}>`;
    const close = "</code></pre>";
    const body = match[2] ?? "";
    const maxBody = maxLength - open.length - close.length;
    if (maxBody <= 1 || body.length <= maxBody) return [html];

    const chunks: string[] = [];
    for (let index = 0; index < body.length; index += maxBody) {
      chunks.push(`${open}${body.slice(index, index + maxBody)}${close}`);
    }
    return chunks;
  }

  for (const nodeHtml of renderedNodes) {
    if (/^<pre><code/.test(nodeHtml) && nodeHtml.includes("</code></pre>") && nodeHtml.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitCodeBlockChunk(nodeHtml));
      continue;
    }

    if (!current) {
      current = nodeHtml;
      continue;
    }

    const candidate = `${current}\n${nodeHtml}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = nodeHtml;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}
