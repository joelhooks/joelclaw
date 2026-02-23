export type ContextExpansionMode =
  | "snippet-window"
  | "parent-section"
  | "section-neighborhood";

export interface BookChunkingOptions {
  sectionTargetTokens?: number;
  sectionMaxTokens?: number;
  sectionOverlapTokens?: number;
  snippetTargetTokens?: number;
  snippetMaxTokens?: number;
  snippetOverlapTokens?: number;
}

export interface BookSectionChunk {
  chunk_id: string;
  doc_id: string;
  section_index: number;
  section_part_index: number;
  heading_path: string[];
  context_prefix: string;
  text: string;
  token_count: number;
  prev_chunk_id?: string;
  next_chunk_id?: string;
}

export interface BookSnippetChunk {
  chunk_id: string;
  doc_id: string;
  snippet_index: number;
  snippet_part_index: number;
  parent_chunk_id: string;
  parent_section_index: number;
  heading_path: string[];
  context_prefix: string;
  text: string;
  token_count: number;
  prev_chunk_id?: string;
  next_chunk_id?: string;
}

export interface BookChunkingResult {
  section_chunks: BookSectionChunk[];
  snippet_chunks: BookSnippetChunk[];
  stats: {
    section_chunks: number;
    snippet_chunks: number;
    avg_section_tokens: number;
    avg_snippet_tokens: number;
  };
}

export interface BookContextOptions {
  mode?: ContextExpansionMode;
  beforeSnippets?: number;
  afterSnippets?: number;
  neighborSections?: number;
}

export interface BookContextResult {
  mode: ContextExpansionMode;
  snippet: BookSnippetChunk;
  snippets: BookSnippetChunk[];
  sections: BookSectionChunk[];
  text: string;
  token_count: number;
}

const WORDS_TO_TOKEN_RATIO = 1.25;
const DEFAULT_SECTION_TARGET = 1_700;
const DEFAULT_SECTION_MAX = 2_200;
const DEFAULT_SECTION_OVERLAP = 120;
const DEFAULT_SNIPPET_TARGET = 420;
const DEFAULT_SNIPPET_MAX = 560;
const DEFAULT_SNIPPET_OVERLAP = 80;

type ParsedSection = {
  section_index: number;
  heading_path: string[];
  text: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeBookText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2")
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.max(1, Math.round(words * WORDS_TO_TOKEN_RATIO));
}

function wordsForTokens(tokens: number): number {
  return Math.max(1, Math.round(tokens / WORDS_TO_TOKEN_RATIO));
}

function splitSentences(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!sentences) return [normalized];
  return sentences.map((part) => normalizeWhitespace(part)).filter(Boolean);
}

function splitWords(text: string): string[] {
  return normalizeWhitespace(text).split(/\s+/).filter(Boolean);
}

function takeTrailingWords(text: string, count: number): string {
  if (count <= 0) return "";
  const words = splitWords(text);
  if (words.length === 0) return "";
  return words.slice(Math.max(0, words.length - count)).join(" ");
}

function cleanHeading(line: string): string {
  return normalizeWhitespace(line.replace(/^#+\s*/, "").replace(/\s+$/, ""));
}

function inferHeadingDepth(heading: string): number {
  const trimmed = heading.trim();
  if (/^part\s+[A-Za-z0-9]+/i.test(trimmed)) return 1;
  if (/^chapter\s+[A-Za-z0-9]+/i.test(trimmed)) return 2;

  const numbered = trimmed.match(/^(\d+(?:\.\d+){0,3})\b/);
  if (numbered && numbered[1]) {
    return Math.min(4, numbered[1].split(".").length);
  }

  const roman = trimmed.match(/^([IVXLCM]+)\b/i);
  if (roman) return 2;
  return 3;
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length > 120) return false;
  if (/^[\-*•]/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/^\[[0-9]+\]/.test(trimmed)) return false;

  const explicitHashHeading = /^#{1,6}\s+\S/.test(trimmed);
  if (explicitHashHeading) return true;

  const chapterLike = /^(part|chapter|section)\s+[A-Za-z0-9]+/i.test(trimmed);
  if (chapterLike) return true;

  const numberedHeading = /^(\d+(?:\.\d+){0,3}|[IVXLCM]+)[\s:.-]+[A-Za-z]/i.test(trimmed);
  if (numberedHeading) return true;

  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 12) return false;
  if (/[.!?]$/.test(trimmed)) return false;

  const allCaps = /^[A-Z0-9 '&(),\-:]+$/.test(trimmed);
  if (allCaps) return true;

  const titleCase = /^[A-Z][A-Za-z0-9'’&(),\-: ]+$/.test(trimmed);
  return titleCase;
}

function shouldDropBoilerplateLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^page\s+\d+$/i.test(trimmed)) return true;
  if (/^\d{1,4}$/.test(trimmed)) return true;
  if (/^copyright\b/i.test(trimmed)) return true;
  return false;
}

function parseSections(text: string): ParsedSection[] {
  const normalized = normalizeBookText(text);
  const lines = normalized.split("\n");
  const sections: ParsedSection[] = [];

  let currentPath: string[] = [];
  let currentLines: string[] = [];
  let sectionIndex = 0;
  let previousWasBlank = true;

  const flushCurrent = () => {
    const body = currentLines.join("\n").trim();
    currentLines = [];
    if (!body) return;
    const headingPath = currentPath.length > 0 ? [...currentPath] : ["Document"];
    sections.push({
      section_index: sectionIndex,
      heading_path: headingPath,
      text: body,
    });
    sectionIndex += 1;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const trimmed = line.trim();

    if (shouldDropBoilerplateLine(trimmed)) {
      continue;
    }

    if (!trimmed) {
      currentLines.push("");
      previousWasBlank = true;
      continue;
    }

    const isHeading = isHeadingLine(trimmed) && previousWasBlank;
    if (isHeading) {
      flushCurrent();
      const cleaned = cleanHeading(trimmed);
      const depth = inferHeadingDepth(cleaned);
      const nextPath = currentPath.slice(0, Math.max(0, depth - 1));
      nextPath.push(cleaned);
      currentPath = nextPath;
      previousWasBlank = false;
      continue;
    }

    currentLines.push(line);
    previousWasBlank = false;
  }

  flushCurrent();
  if (sections.length > 0) return sections;

  const fallback = normalizeWhitespace(normalized);
  if (!fallback) return [];
  return [{
    section_index: 0,
    heading_path: ["Document"],
    text: fallback,
  }];
}

function splitLongUnit(unit: string, maxTokens: number): string[] {
  if (estimateTokens(unit) <= maxTokens) return [normalizeWhitespace(unit)];

  const sentences = splitSentences(unit);
  if (sentences.length > 1) {
    const chunks: string[] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = estimateTokens(sentence);
      if (current.length > 0 && currentTokens + sentenceTokens > maxTokens) {
        chunks.push(normalizeWhitespace(current.join(" ")));
        current = [sentence];
        currentTokens = sentenceTokens;
        continue;
      }
      current.push(sentence);
      currentTokens += sentenceTokens;
    }

    if (current.length > 0) {
      chunks.push(normalizeWhitespace(current.join(" ")));
    }
    return chunks.filter(Boolean);
  }

  const words = splitWords(unit);
  if (words.length === 0) return [];
  const wordsPerChunk = Math.max(50, wordsForTokens(maxTokens));
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
  }
  return chunks.filter(Boolean);
}

function splitByTokens(
  text: string,
  targetTokens: number,
  maxTokens: number,
  overlapTokens: number
): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const baseChunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flushCurrent = () => {
    if (current.length === 0) return;
    const chunkText = normalizeWhitespace(current.join("\n\n"));
    if (chunkText) baseChunks.push(chunkText);
    current = [];
    currentTokens = 0;
  };

  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);
    if (paragraphTokens > maxTokens) {
      flushCurrent();
      const parts = splitLongUnit(paragraph, maxTokens);
      for (const part of parts) {
        baseChunks.push(part);
      }
      continue;
    }

    const nextTokens = currentTokens + paragraphTokens;
    if (
      current.length > 0 &&
      (nextTokens > maxTokens || (currentTokens >= targetTokens && paragraphTokens > 90))
    ) {
      flushCurrent();
    }

    current.push(paragraph);
    currentTokens += paragraphTokens;
  }

  flushCurrent();
  if (baseChunks.length === 0) return [];
  if (overlapTokens <= 0 || baseChunks.length < 2) return baseChunks;

  const overlapWords = wordsForTokens(overlapTokens);
  const overlapped: string[] = [baseChunks[0]!];
  for (let i = 1; i < baseChunks.length; i += 1) {
    const prev = baseChunks[i - 1]!;
    const currentChunk = baseChunks[i]!;
    const overlapText = takeTrailingWords(prev, overlapWords);
    if (!overlapText) {
      overlapped.push(currentChunk);
      continue;
    }
    overlapped.push(normalizeWhitespace(`${overlapText} ${currentChunk}`));
  }
  return overlapped;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function linkSequentialChunks<T extends { chunk_id: string; prev_chunk_id?: string; next_chunk_id?: string }>(
  chunks: T[]
): void {
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    chunk.prev_chunk_id = i > 0 ? chunks[i - 1]?.chunk_id : undefined;
    chunk.next_chunk_id = i < chunks.length - 1 ? chunks[i + 1]?.chunk_id : undefined;
  }
}

export function chunkBookText(
  docId: string,
  rawText: string,
  options: BookChunkingOptions = {}
): BookChunkingResult {
  const sections = parseSections(rawText);
  const sectionTarget = options.sectionTargetTokens ?? DEFAULT_SECTION_TARGET;
  const sectionMax = options.sectionMaxTokens ?? DEFAULT_SECTION_MAX;
  const sectionOverlap = options.sectionOverlapTokens ?? DEFAULT_SECTION_OVERLAP;
  const snippetTarget = options.snippetTargetTokens ?? DEFAULT_SNIPPET_TARGET;
  const snippetMax = options.snippetMaxTokens ?? DEFAULT_SNIPPET_MAX;
  const snippetOverlap = options.snippetOverlapTokens ?? DEFAULT_SNIPPET_OVERLAP;

  const sectionChunks: BookSectionChunk[] = [];
  const snippetChunks: BookSnippetChunk[] = [];

  let globalSectionChunkIndex = 0;
  let globalSnippetIndex = 0;

  for (const section of sections) {
    const contextPrefix = section.heading_path.join(" > ");
    const sectionParts = splitByTokens(section.text, sectionTarget, sectionMax, sectionOverlap);
    if (sectionParts.length === 0) continue;

    for (let sectionPartIndex = 0; sectionPartIndex < sectionParts.length; sectionPartIndex += 1) {
      const sectionPart = sectionParts[sectionPartIndex]!;
      const sectionChunkId = `${docId}:s${globalSectionChunkIndex}`;
      const sectionChunk: BookSectionChunk = {
        chunk_id: sectionChunkId,
        doc_id: docId,
        section_index: section.section_index,
        section_part_index: sectionPartIndex,
        heading_path: section.heading_path,
        context_prefix: contextPrefix,
        text: sectionPart,
        token_count: estimateTokens(sectionPart),
      };
      sectionChunks.push(sectionChunk);
      globalSectionChunkIndex += 1;

      const snippetParts = splitByTokens(sectionPart, snippetTarget, snippetMax, snippetOverlap);
      if (snippetParts.length === 0) continue;
      for (let snippetPartIndex = 0; snippetPartIndex < snippetParts.length; snippetPartIndex += 1) {
        const snippetPart = snippetParts[snippetPartIndex]!;
        snippetChunks.push({
          chunk_id: `${sectionChunkId}:n${snippetPartIndex}`,
          doc_id: docId,
          snippet_index: globalSnippetIndex,
          snippet_part_index: snippetPartIndex,
          parent_chunk_id: sectionChunkId,
          parent_section_index: section.section_index,
          heading_path: section.heading_path,
          context_prefix: contextPrefix,
          text: snippetPart,
          token_count: estimateTokens(snippetPart),
        });
        globalSnippetIndex += 1;
      }
    }
  }

  linkSequentialChunks(sectionChunks);
  linkSequentialChunks(snippetChunks);

  return {
    section_chunks: sectionChunks,
    snippet_chunks: snippetChunks,
    stats: {
      section_chunks: sectionChunks.length,
      snippet_chunks: snippetChunks.length,
      avg_section_tokens: average(sectionChunks.map((chunk) => chunk.token_count)),
      avg_snippet_tokens: average(snippetChunks.map((chunk) => chunk.token_count)),
    },
  };
}

export function renderChunkForEmbedding(
  chunk: Pick<BookSectionChunk | BookSnippetChunk, "context_prefix" | "text">
): string {
  const prefix = normalizeWhitespace(chunk.context_prefix);
  if (!prefix) return normalizeWhitespace(chunk.text);
  return normalizeWhitespace(`${prefix}\n\n${chunk.text}`);
}

function uniqueByChunkId<T extends { chunk_id: string }>(chunks: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.chunk_id)) continue;
    seen.add(chunk.chunk_id);
    result.push(chunk);
  }
  return result;
}

export function buildBookContext(
  chunking: BookChunkingResult,
  snippetChunkId: string,
  options: BookContextOptions = {}
): BookContextResult {
  const mode = options.mode ?? "snippet-window";
  const before = options.beforeSnippets ?? 2;
  const after = options.afterSnippets ?? 2;
  const neighbors = options.neighborSections ?? 1;

  const snippetIndex = chunking.snippet_chunks.findIndex((chunk) => chunk.chunk_id === snippetChunkId);
  if (snippetIndex === -1) {
    throw new Error(`Unknown snippet chunk: ${snippetChunkId}`);
  }

  const snippet = chunking.snippet_chunks[snippetIndex]!;
  const parentSection = chunking.section_chunks.find(
    (sectionChunk) => sectionChunk.chunk_id === snippet.parent_chunk_id
  );
  if (!parentSection) {
    throw new Error(`Snippet ${snippetChunkId} has missing parent section ${snippet.parent_chunk_id}`);
  }

  const windowStart = Math.max(0, snippetIndex - before);
  const windowEnd = Math.min(chunking.snippet_chunks.length, snippetIndex + after + 1);
  const snippetWindow = chunking.snippet_chunks.slice(windowStart, windowEnd);

  let snippets: BookSnippetChunk[] = [];
  let sections: BookSectionChunk[] = [];

  if (mode === "snippet-window") {
    snippets = snippetWindow;
    sections = [parentSection];
  } else if (mode === "parent-section") {
    snippets = chunking.snippet_chunks.filter((item) => item.parent_chunk_id === parentSection.chunk_id);
    sections = [parentSection];
  } else {
    const parentSectionIndex = chunking.section_chunks.findIndex(
      (item) => item.chunk_id === parentSection.chunk_id
    );
    const start = Math.max(0, parentSectionIndex - neighbors);
    const end = Math.min(chunking.section_chunks.length, parentSectionIndex + neighbors + 1);
    sections = chunking.section_chunks.slice(start, end);
    const sectionIds = new Set(sections.map((item) => item.chunk_id));
    snippets = chunking.snippet_chunks.filter((item) => sectionIds.has(item.parent_chunk_id));
  }

  snippets = uniqueByChunkId(snippets);
  sections = uniqueByChunkId(sections);

  const textParts: string[] = [];
  if (mode === "snippet-window") {
    for (const item of snippets) {
      textParts.push(renderChunkForEmbedding(item));
    }
  } else {
    for (const section of sections) {
      textParts.push(renderChunkForEmbedding(section));
    }
  }

  const text = textParts.join("\n\n");
  return {
    mode,
    snippet,
    snippets,
    sections,
    text,
    token_count: estimateTokens(text),
  };
}
