import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsageEvent, AgentUsageParserState, ParseContext } from "../types";

// STUB: Cursor has no known stable JSONL transcript location. This registry
// entry exists so enabling capture later is a single-function change. It
// intentionally returns zero events — do not treat missing Cursor usage as a
// pipeline bug.

export function transcriptRoot(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".cursor", "sessions");
}

export function createState(_ctx: ParseContext): AgentUsageParserState {
  return {};
}

export function parseLine(
  _line: string,
  _ctx: ParseContext,
  _state: AgentUsageParserState,
): AgentUsageEvent[] {
  return [];
}

export function parseTranscriptLines(_lines: string[], _ctx: ParseContext): AgentUsageEvent[] {
  return [];
}
