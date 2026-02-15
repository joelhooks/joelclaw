export interface ObserverOutput {
  observations: string;
  segments: DistilledSegment[];
  currentTask: string | null;
  suggestedResponse: string | null;
  parsed: boolean;
}

export interface DistilledSegment {
  narrative: string;
  facts: string[];
}

export function optimizeForContext(observations: string): string {
  if (observations.trim().length === 0) {
    return "";
  }

  const segments = parseSegments(observations);
  if (segments.length > 0) {
    const optimized: string[] = [];

    for (const segment of segments) {
      if (segment.narrative.trim().length > 0) {
        optimized.push(segment.narrative);
      }

      for (const fact of segment.facts) {
        if (fact.includes("🔴")) {
          optimized.push(fact);
        }
      }
    }

    return optimized.join("\n").trim();
  }

  return observations
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("🟡") || line.includes("🟢")) {
        return false;
      }

      return line.includes("🔴") || line.startsWith("Date:");
    })
    .join("\n")
    .trim();
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

export function parseSegments(observations: string): DistilledSegment[] {
  const segmentPattern = /<segment>([\s\S]*?)<\/segment>/gi;
  const segments = observations.matchAll(segmentPattern);
  const parsed: DistilledSegment[] = [];

  for (const segmentMatch of segments) {
    const segmentBody = segmentMatch[1] ?? "";
    const narrative = (extractTagContent(segmentBody, "narrative") ?? "").trim();
    const factsBody = extractTagContent(segmentBody, "facts") ?? "";
    const facts = factsBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => line.length > 0);

    parsed.push({ narrative, facts });
  }

  return parsed;
}

export function formatSegmentsForLog(segments: DistilledSegment[]): string {
  if (segments.length === 0) {
    return "";
  }

  return segments
    .map((segment) => {
      const lines = [`*${segment.narrative.trim()}*`];

      for (const fact of segment.facts) {
        const trimmedFact = fact.trim();
        if (trimmedFact.length > 0) {
          lines.push(`- ${trimmedFact}`);
        }
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

export function parseObserverOutput(raw: string): ObserverOutput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      observations: "",
      segments: [],
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    };
  }

  const observations = extractTagContent(raw, "observations");
  if (observations !== null) {
    return {
      observations,
      segments: parseSegments(observations),
      currentTask: extractTagContent(raw, "current-task"),
      suggestedResponse: extractTagContent(raw, "suggested-response"),
      parsed: true,
    };
  }

  if (hasObserverEmojiMarkers(raw)) {
    return {
      observations: raw,
      segments: [],
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    };
  }

  return {
    observations: raw,
    segments: [],
    currentTask: null,
    suggestedResponse: null,
    parsed: false,
  };
}
