export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costInput?: number;
  costOutput?: number;
  costTotal?: number;
};

type PiAssistantMessage = {
  role?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: {
      input?: number;
      output?: number;
      total?: number;
    };
  };
  content?: Array<{ type?: string; text?: string }>;
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parsePiJsonAssistant(raw: string): {
  text: string;
  provider?: string;
  model?: string;
  usage?: LlmUsage;
} | null {
  const lines = raw.split(/\r?\n/gu);
  let assistant: PiAssistantMessage | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        message?: PiAssistantMessage;
      };

      if ((parsed.type === "turn_end" || parsed.type === "message_end") && parsed.message?.role === "assistant") {
        assistant = parsed.message;
      }
    } catch {
      // ignore malformed lines
    }
  }

  if (!assistant) return null;

  const text = (assistant.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part?.text ?? "")
    .join("")
    .trim();

  const usage = assistant.usage
    ? {
        inputTokens: toFiniteNumber(assistant.usage.input),
        outputTokens: toFiniteNumber(assistant.usage.output),
        totalTokens: toFiniteNumber(assistant.usage.totalTokens),
        cacheReadTokens: toFiniteNumber(assistant.usage.cacheRead),
        cacheWriteTokens: toFiniteNumber(assistant.usage.cacheWrite),
        costInput: toFiniteNumber(assistant.usage.cost?.input),
        costOutput: toFiniteNumber(assistant.usage.cost?.output),
        costTotal: toFiniteNumber(assistant.usage.cost?.total),
      }
    : undefined;

  return {
    text,
    provider: assistant.provider,
    model: assistant.model,
    usage,
  };
}
