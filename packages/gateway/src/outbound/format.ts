import type { InlineButton } from "../channels/telegram";

export type FormatRule = {
  pattern: RegExp;
  buttons: InlineButton[][];
};

const RULES: FormatRule[] = [
  {
    pattern: /health.*(degraded|error|fail)/i,
    buttons: [[{ text: "🔄 Restart Worker", action: "restart:worker" }]],
  },
  {
    pattern: /email.*(triage|scan|inbox)/i,
    buttons: [[
      { text: "📦 Archive All", action: "email:archive" },
      { text: "⭐ Flag Important", action: "email:flag" },
    ]],
  },
  {
    pattern: /loop.*(complete|finish)/i,
    buttons: [[
      { text: "📊 Results", action: "loop:results" },
      { text: "🔁 Re-run", action: "loop:rerun" },
    ]],
  },
  {
    pattern: /memory.*(proposal|review)/i,
    buttons: [[
      { text: "✅ Approve", action: "memory:approve" },
      { text: "❌ Reject", action: "memory:reject" },
    ]],
  },
];

export function applyFormatRules(text: string): { text: string; buttons?: InlineButton[][] } {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { text, buttons: rule.buttons };
    }
  }

  return { text };
}

export function telegramChannelContext(): string {
  return "[Channel: telegram | Format: HTML (b/i/code/pre/a/blockquote) | Max: 4096 chars | Supports: inline-keyboards, reply-threading, voice-notes]";
}
