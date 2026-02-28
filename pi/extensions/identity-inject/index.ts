import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "~";
const JOELCLAW_DIR = join(HOME, ".joelclaw");

const IDENTITY_FILES = [
  { label: "Identity", file: "IDENTITY.md" },
  { label: "Soul", file: "SOUL.md" },
  { label: "Role", file: "ROLE.md" },
  { label: "User", file: "USER.md" },
  { label: "Tools", file: "TOOLS.md", maxChars: 6_000 },
] as const;

function readIfExists(path: string, maxChars?: number): string | null {
  try {
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return null;
    if (!maxChars || content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n\n[Truncated to ${maxChars} chars]`;
  } catch {
    return null;
  }
}

function loadIdentityBlock(): string {
  const sections: string[] = [];

  for (const { file, maxChars } of IDENTITY_FILES) {
    const content = readIfExists(join(JOELCLAW_DIR, file), maxChars);
    if (content) sections.push(content);
  }

  if (sections.length === 0) return "";

  return (
    "\n\n# Identity & Context\n\n"
    + sections.join("\n\n---\n\n")
    + "\n"
  );
}

export default function (pi: ExtensionAPI) {
  let identityBlock = "";

  pi.on("session_start", async () => {
    identityBlock = loadIdentityBlock();
    const count = IDENTITY_FILES.filter(f => readIfExists(join(JOELCLAW_DIR, f.file))).length;
    console.error(`[identity-inject] Loaded ${count} identity files from ${JOELCLAW_DIR}`);
  });

  pi.on("before_agent_start", async (event) => {
    if (!identityBlock) return;

    return {
      systemPrompt: identityBlock + "\n" + event.systemPrompt,
    };
  });
}
