import type { PiExtension } from "@anthropic-ai/pi";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const JOELCLAW_DIR = join(process.env.HOME || "", ".joelclaw");

const IDENTITY_FILES = [
  { label: "Identity", path: join(JOELCLAW_DIR, "IDENTITY.md") },
  { label: "Soul", path: join(JOELCLAW_DIR, "SOUL.md") },
  { label: "Role", path: join(JOELCLAW_DIR, "ROLE.md") },
  { label: "User", path: join(JOELCLAW_DIR, "USER.md") },
  { label: "Tools", path: join(JOELCLAW_DIR, "TOOLS.md") },
];

function loadIdentityBlock(): string {
  const blocks: string[] = [];
  for (const { label, path } of IDENTITY_FILES) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf-8").trim();
      if (content) blocks.push(content);
    } catch {
      // skip unreadable files
    }
  }
  return blocks.length > 0 ? "\n\n" + blocks.join("\n\n---\n\n") : "";
}

const extension: PiExtension = (pi) => {
  // Cache the identity block at session start — these files don't change mid-session
  const identityBlock = loadIdentityBlock();

  if (!identityBlock) {
    console.error("[identity-inject] No identity files found in", JOELCLAW_DIR);
    return;
  }

  const fileCount = IDENTITY_FILES.filter(f => existsSync(f.path)).length;
  console.error(`[identity-inject] Loaded ${fileCount} identity files`);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + identityBlock,
    };
  });
};

export default extension;
