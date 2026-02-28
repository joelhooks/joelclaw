const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const VALID_TAG_PATTERN = /^<\/?[A-Za-z]\w*(?:\s+[^<>]*?)?\s*\/?>/;

export function escapeMdxAngleBrackets(content: string): string {
  let result = "";
  let lastIndex = 0;

  for (const match of content.matchAll(FENCED_CODE_BLOCK_PATTERN)) {
    const start = match.index ?? 0;
    result += escapePreservingInlineCode(content.slice(lastIndex, start));
    result += match[0];
    lastIndex = start + match[0].length;
  }

  result += escapePreservingInlineCode(content.slice(lastIndex));
  return result;
}

function escapePreservingInlineCode(content: string): string {
  let result = "";
  let index = 0;

  while (index < content.length) {
    if (content[index] !== "`") {
      const nextBacktick = content.indexOf("`", index);
      const end = nextBacktick === -1 ? content.length : nextBacktick;
      result += escapeAngleBracketsInText(content.slice(index, end));
      index = end;
      continue;
    }

    let ticks = 0;
    while (content[index + ticks] === "`") {
      ticks += 1;
    }

    const delimiter = "`".repeat(ticks);
    const closingIndex = content.indexOf(delimiter, index + ticks);

    if (closingIndex === -1) {
      result += delimiter;
      index += ticks;
      continue;
    }

    result += content.slice(index, closingIndex + ticks);
    index = closingIndex + ticks;
  }

  return result;
}

function escapeAngleBracketsInText(content: string): string {
  let result = "";
  let index = 0;

  while (index < content.length) {
    const char = content[index];

    if (char === "<") {
      const tagMatch = content.slice(index).match(VALID_TAG_PATTERN);

      if (tagMatch) {
        result += tagMatch[0];
        index += tagMatch[0].length;
        continue;
      }

      result += "&lt;";
      index += 1;
      continue;
    }

    if (char === ">") {
      result += "&gt;";
      index += 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}
