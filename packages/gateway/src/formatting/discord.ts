export const DISCORD_CAPABILITIES = "embeds, components v2 containers, buttons, threads, reactions, code blocks, file attachments";

export const DISCORD_FORMATTING_GUIDE = [
  "- Use Components V2 containers for structured responses.",
  "- Prefer sections + separators to keep dense information readable.",
  "- Use buttons only for real actions.",
  "- Use fenced code blocks for technical output.",
  "- Avoid markdown tables; use sections or code blocks.",
  "- Keep long output chunked and thread-aware.",
].join("\\n");
