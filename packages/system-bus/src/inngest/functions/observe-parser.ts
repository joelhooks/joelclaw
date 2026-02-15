export interface ObserverOutput {
  observations: string;
  currentTask: string | null;
  suggestedResponse: string | null;
  parsed: boolean;
}

function extractTagContent(raw: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = raw.match(pattern);
  if (!match) {
    return null;
  }

  return (match[1] ?? "").trim();
}

function hasObserverEmojiMarkers(raw: string): boolean {
  return raw
    .split(/\r?\n/)
    .some((line) => line.includes("🔴") || line.includes("🟡") || line.includes("🟢"));
}

export function parseObserverOutput(raw: string): ObserverOutput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      observations: "",
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    };
  }

  const observations = extractTagContent(raw, "observations");
  if (observations !== null) {
    return {
      observations,
      currentTask: extractTagContent(raw, "current-task"),
      suggestedResponse: extractTagContent(raw, "suggested-response"),
      parsed: true,
    };
  }

  if (hasObserverEmojiMarkers(raw)) {
    return {
      observations: raw,
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    };
  }

  return {
    observations: raw,
    currentTask: null,
    suggestedResponse: null,
    parsed: false,
  };
}
