import { ValidationResult } from "../types";

type ValidationIssue = {
  rule: string;
  message: string;
  position: number | undefined;
};

interface OpenTagFrame {
  tag: string;
  startPos: number;
  contentStart: number;
}

const ALLOWED_TAGS = new Set(["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"]);
const CHUNK_MAX_LENGTH = 4096;

function addValidationIssue(
  issues: ValidationIssue[],
  rule: string,
  message: string,
  position?: number
): void {
  issues.push({ rule, message, position });
}

function parseTag(raw: string) {
  const body = raw.slice(1, -1).trim();
  const isClosing = body.startsWith("/");
  const isSelfClosing = /\s*\/\s*$/.test(body);
  const trimmed = isClosing ? body.replace(/^\//, "").trim() : body;
  const cleanBody = isSelfClosing ? trimmed.replace(/\s*\/\s*$/, "").trim() : trimmed;
  const match = cleanBody.match(/^([a-zA-Z][\w-]*)([\s\S]*)$/);
  if (!match) return null;

  return {
    isClosing,
    isSelfClosing,
    tagName: match[1].toLowerCase(),
    attributes: match[2] ?? "",
  };
}

function validateHref(attributes: string, position: number, warnings: ValidationIssue[]): void {
  const hrefMatch = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/i);
  if (!hrefMatch) {
    addValidationIssue(warnings, "valid-href", "Anchor tag is missing href.", position);
    return;
  }

  const href = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
  if (!href) {
    addValidationIssue(warnings, "valid-href", "Anchor href must be non-empty.", position);
  }
}

function scanBareAmpersands(text: string, offset: number, warnings: ValidationIssue[]) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "&") continue;

    if (!/^(amp|lt|gt|quot);/.test(text.slice(index + 1))) {
      addValidationIssue(
        warnings,
        "ampersand-escape",
        "Bare ampersand should be HTML-escaped.",
        offset + index
      );
    }
  }
}

export function validateTelegramHtml(html: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const stack: OpenTagFrame[] = [];

  let entityCount = 0;
  const tagMatcher = /<[^>]*>/g;
  let match: RegExpExecArray | null;
  let cursor = 0;

  while ((match = tagMatcher.exec(html)) !== null) {
    const tagText = match[0] ?? "";
    const tagStart = match.index ?? 0;
    const textBeforeTag = html.slice(cursor, tagStart);
    scanBareAmpersands(textBeforeTag, cursor, warnings);
    cursor = tagStart + tagText.length;
    scanBareAmpersands(tagText, tagStart, warnings);

    const parsed = parseTag(tagText);
    if (!parsed) {
      addValidationIssue(errors, "no-unsupported-tags", `Could not parse tag: ${tagText}`, tagStart);
      continue;
    }

    const { isClosing, isSelfClosing, tagName, attributes } = parsed;
    if (!ALLOWED_TAGS.has(tagName)) {
      addValidationIssue(errors, "no-unsupported-tags", `Unsupported tag: ${tagName}`, tagStart);
      continue;
    }

    if (isSelfClosing) {
      addValidationIssue(
        errors,
        "no-unsupported-tags",
        `Self-closing tags are not supported: ${tagName}`,
        tagStart
      );
      continue;
    }

    if (isClosing) {
      const open = stack.pop();
      if (!open || open.tag !== tagName) {
        addValidationIssue(
          errors,
          "balanced-tags",
          `Mismatched close tag: ${tagName}`,
          tagStart
        );
        continue;
      }

      const inner = html.slice(open.contentStart, tagStart);
      const innerWithoutNestedTags = inner.replace(/<[^>]*>/g, "");
      if (!innerWithoutNestedTags.trim()) {
        addValidationIssue(warnings, "no-empty-tags", `Empty tag: ${tagName}`, open.startPos);
      }
      continue;
    }

    entityCount += 1;
    if (tagName === "pre") {
      if (stack.some((entry) => entry.tag === "pre" || entry.tag === "blockquote")) {
        addValidationIssue(
          errors,
          "no-nested-pre",
          "<pre> cannot be nested inside <blockquote> or another <pre>.",
          tagStart
        );
      }
    }

    if (tagName === "a" && stack.some((entry) => entry.tag === "a")) {
      addValidationIssue(errors, "no-nested-links", "<a> cannot be nested inside another <a>.", tagStart);
    }

    if (tagName === "a") {
      validateHref(attributes, tagStart, warnings);
    }

    stack.push({
      tag: tagName,
      startPos: tagStart,
      contentStart: cursor,
    });
  }

  if (cursor < html.length) {
    scanBareAmpersands(html.slice(cursor), cursor, warnings);
  }

  if (html.length > CHUNK_MAX_LENGTH) {
    addValidationIssue(errors, "max-length", `Message exceeds Telegram limit of ${CHUNK_MAX_LENGTH}.`, CHUNK_MAX_LENGTH);
  }

  if (entityCount > 100) {
    addValidationIssue(
      errors,
      "entity-count",
      `Too many Telegram entities: ${entityCount} (max 100).`,
      0
    );
  } else if (entityCount > 80) {
    addValidationIssue(
      warnings,
      "entity-count",
      `High Telegram entity count: ${entityCount} (recommended <= 80).`,
      0
    );
  }

  for (const openTag of stack) {
    addValidationIssue(
      errors,
      "balanced-tags",
      `Unclosed tag: ${openTag.tag}`,
      openTag.startPos
    );
  }

  return {
    valid: errors.length === 0,
    errors: errors.map(({ rule, message, position }) => ({ rule, message, position })),
    warnings: warnings.map(({ rule, message, position }) => ({ rule, message, position })),
  };
}
