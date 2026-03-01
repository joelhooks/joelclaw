import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const HOME = process.env.HOME ?? "~";
const JOELCLAW_DIR = join(HOME, ".joelclaw");

const IDENTITY_FILES: ReadonlyArray<{
  label: string;
  file: string;
  maxChars?: number;
}> = [
  { label: "Identity", file: "IDENTITY.md" },
  { label: "Soul", file: "SOUL.md" },
  { label: "Role", file: "ROLE.md" },
  { label: "User", file: "USER.md" },
  { label: "Tools", file: "TOOLS.md", maxChars: 6_000 },
] as const;

async function emitOtel(action: string, data: Record<string, unknown>) {
  try {
    await fetch("http://localhost:3111/observability/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        timestamp: Date.now(),
        level: "info",
        source: "gateway",
        component: "identity-inject",
        action,
        success: true,
        metadata: data,
      }),
    });
  } catch {}
}

type ReadIdentityFileResult = {
  content: string | null;
  truncated: boolean;
};

function readIfExists(path: string, maxChars?: number): ReadIdentityFileResult {
  try {
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return { content: null, truncated: false };
    if (!maxChars || content.length <= maxChars) return { content, truncated: false };
    return {
      content: `${content.slice(0, maxChars)}\n\n[Truncated to ${maxChars} chars]`,
      truncated: true,
    };
  } catch {
    return { content: null, truncated: false };
  }
}

type LoadedIdentityFile = {
  file: string;
  content: string;
  size: number;
};

type LoadedIdentityFilesResult = {
  loadedFiles: LoadedIdentityFile[];
  totalChars: number;
  missingFiles: string[];
  truncatedFiles: string[];
  loadTimeMs: number;
};

function loadIdentityFiles(): LoadedIdentityFilesResult {
  const startTime = Date.now();
  const loaded: LoadedIdentityFile[] = [];
  const missingFiles: string[] = [];
  const truncatedFiles: string[] = [];
  let totalChars = 0;

  for (const { file, maxChars } of IDENTITY_FILES) {
    const { content, truncated } = readIfExists(join(JOELCLAW_DIR, file), maxChars);
    if (!content) {
      missingFiles.push(file);
      continue;
    }

    const size = content.length;
    loaded.push({ file, content, size });
    totalChars += size;
    if (truncated) truncatedFiles.push(file);
  }

  return {
    loadedFiles: loaded,
    totalChars,
    missingFiles,
    truncatedFiles,
    loadTimeMs: Date.now() - startTime,
  };
}

function loadIdentityBlock(loadedFiles: LoadedIdentityFile[]): string {
  if (loadedFiles.length === 0) return "";

  return (
    "\n\n# Identity & Context\n\n"
    + loadedFiles.map(({ content }) => content).join("\n\n---\n\n")
    + "\n"
  );
}

export default function (pi: ExtensionAPI) {
  let identityBlock = "";
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    const {
      loadedFiles,
      totalChars,
      missingFiles,
      truncatedFiles,
      loadTimeMs,
    } = loadIdentityFiles();
    identityBlock = loadIdentityBlock(loadedFiles);
    loaded = true;
    const count = loadedFiles.length;
    console.error(`[identity-inject] Loaded ${count} identity files from ${JOELCLAW_DIR}`);
    emitOtel("identity-loaded", {
      fileCount: count,
      files: loadedFiles.map(({ file, size }) => ({ file, size })),
      totalChars,
      missingFiles,
      truncatedFiles,
      loadTimeMs,
      identityDir: JOELCLAW_DIR,
    });
  }

  pi.on("session_start", async () => {
    ensureLoaded();
  });

  pi.on("before_agent_start", async (event) => {
    ensureLoaded();

    if (!identityBlock) {
      await emitOtel("prompt-inject-skipped", {
        reason: "no-identity-files-found",
      });
      return;
    }

    await emitOtel("prompt-injected", {
      identityChars: identityBlock.length,
      systemPromptChars: event.systemPrompt.length,
      totalChars: identityBlock.length + event.systemPrompt.length,
    });

    return {
      systemPrompt: identityBlock + "\n" + event.systemPrompt,
    };
  });
}
