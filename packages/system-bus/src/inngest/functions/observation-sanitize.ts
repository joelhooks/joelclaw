const TOOL_CALL_BLOCK_PATTERN = /<toolCall\b[\s\S]*?<\/toolCall>/giu;
const ARGUMENTS_BLOCK_PATTERN = /<arguments\b[\s\S]*?<\/arguments>/giu;
const TOOL_CALL_TAG_PATTERN = /<\/?toolCall\b[^>]*>/giu;
const ARGUMENTS_TAG_PATTERN = /<\/?arguments\b[^>]*>/giu;
const TOOL_ID_TAG_PATTERN = /<id>\s*toolu_[^<]*<\/id>/giu;
const TOOL_NAME_TAG_PATTERN = /<name>\s*(?:bash|zsh|sh|shell)\s*<\/name>/giu;
const ENCODED_TOOL_CALL_TAG_PATTERN = /&lt;\/?toolCall[^&]*&gt;/giu;
const ENCODED_ARGUMENTS_TAG_PATTERN = /&lt;\/?arguments[^&]*&gt;/giu;
const ENCODED_TOOL_ID_PATTERN = /&lt;id&gt;\s*toolu_[^&]*&lt;\/id&gt;/giu;

const TOOL_CALL_LEAK_PATTERN =
  /<toolCall\b|<\/toolCall>|<arguments\b|<\/arguments>|<id>\s*toolu_|<name>\s*(?:bash|zsh|sh|shell)\s*<\/name>/iu;
const TOOL_ID_PATTERN = /\btoolu_[a-z0-9_-]+\b/iu;
const INTERPRETER_COMMAND_PATTERN = /\b(?:bash|zsh|sh)\s+-lc\b/iu;
const SHELL_BLOCK_PATTERN = /^```(?:bash|sh|zsh|shell)?$/iu;
const PROMPT_COMMAND_PATTERN = /^\s*[$#]\s+\S+/u;
const COMMAND_START_PATTERN =
  /^(?:[$#]\s*)?(?:cd|ls|cat|sed|awk|grep|rg|find|mkdir|rm|mv|cp|touch|chmod|chown|git|npm|pnpm|yarn|npx|bun|bunx|node|python3?|pip|docker|kubectl|helm|curl|wget)\b/iu;
const SPEAKER_PREFIX_PATTERN = /^\s*(User|Assistant|System)\s*:\s*/iu;

function stripToolCallArtifacts(text: string): string {
  return text
    .replace(TOOL_CALL_BLOCK_PATTERN, " ")
    .replace(ARGUMENTS_BLOCK_PATTERN, " ")
    .replace(TOOL_CALL_TAG_PATTERN, " ")
    .replace(ARGUMENTS_TAG_PATTERN, " ")
    .replace(TOOL_ID_TAG_PATTERN, " ")
    .replace(TOOL_NAME_TAG_PATTERN, " ")
    .replace(ENCODED_TOOL_CALL_TAG_PATTERN, " ")
    .replace(ENCODED_ARGUMENTS_TAG_PATTERN, " ")
    .replace(ENCODED_TOOL_ID_PATTERN, " ");
}

function removeBulletPrefix(line: string): string {
  return line.replace(/^[-*•]\s*/u, "").trim();
}

function isLikelyShellCommandLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (SHELL_BLOCK_PATTERN.test(trimmed)) return true;
  if (INTERPRETER_COMMAND_PATTERN.test(trimmed)) return true;
  if (PROMPT_COMMAND_PATTERN.test(trimmed)) return true;
  if (!COMMAND_START_PATTERN.test(trimmed)) return false;

  if (/[|;&`]/u.test(trimmed)) return true;
  if (/[\/\\]/u.test(trimmed)) return true;
  if (/--?[a-z]/iu.test(trimmed)) return true;
  if (/['"`]/u.test(trimmed)) return true;
  if (!/[.!?]/u.test(trimmed) && trimmed.split(/\s+/u).length <= 3) return true;

  return false;
}

function looksLikeInternalShellAction(text: string): boolean {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => removeBulletPrefix(line))
    .filter((line) => line.length > 0);

  if (lines.length === 0) return false;

  const commandLines = lines.filter((line) => isLikelyShellCommandLine(line));
  if (commandLines.length === 0) return false;

  const proseLines = lines.filter(
    (line) => /[.!?]/u.test(line) || line.split(/\s+/u).length >= 10
  );

  if (commandLines.length === lines.length && proseLines.length === 0) return true;
  if (commandLines.length >= 2 && commandLines.length / lines.length >= 0.6 && proseLines.length === 0) {
    return true;
  }
  return false;
}

export function sanitizeObservationText(rawText: string): string | null {
  const stripped = stripToolCallArtifacts(rawText);

  const filteredLines = stripped
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !TOOL_CALL_LEAK_PATTERN.test(line))
    .filter((line) => !TOOL_ID_PATTERN.test(line));

  const cleaned = filteredLines.join("\n").trim();
  if (cleaned.length === 0) return null;

  if (TOOL_CALL_LEAK_PATTERN.test(cleaned)) return null;
  if (TOOL_ID_PATTERN.test(cleaned)) return null;
  if (looksLikeInternalShellAction(cleaned)) return null;

  return cleaned;
}

export function sanitizeObservationTranscript(messages: string): string {
  const stripped = stripToolCallArtifacts(messages);
  if (stripped.trim().length === 0) return "";

  const sanitizedLines = stripped
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !TOOL_CALL_LEAK_PATTERN.test(line))
    .filter((line) => !TOOL_ID_PATTERN.test(line))
    .filter((line) => {
      const speakerMatch = line.match(SPEAKER_PREFIX_PATTERN);
      const speaker = speakerMatch?.[1]?.toLowerCase() ?? "";
      const body = line.replace(SPEAKER_PREFIX_PATTERN, "").trim();

      if ((speaker === "assistant" || speaker.length === 0) && isLikelyShellCommandLine(body)) {
        return false;
      }
      return true;
    });

  return sanitizedLines.join("\n").trim();
}
