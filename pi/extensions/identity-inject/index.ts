import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const HOME = process.env.HOME ?? "~";
const JOELCLAW_DIR = join(HOME, ".joelclaw");
const DEFAULT_ROLE_FILE = "ROLE.md";
const GATEWAY_ROLE_FILE = "roles/gateway.md";

type IdentityFileSpec = {
  label: string;
  file: string;
  maxChars?: number;
};

const BASE_IDENTITY_FILES: ReadonlyArray<IdentityFileSpec> = [
  { label: "Identity", file: "IDENTITY.md" },
  { label: "Soul", file: "SOUL.md" },
  { label: "Role", file: DEFAULT_ROLE_FILE },
  { label: "User", file: "USER.md" },
  { label: "Tools", file: "TOOLS.md", maxChars: 6_000 },
] as const;

function resolvePreferredRoleFile(): string {
  const override = process.env.JOELCLAW_ROLE_FILE?.trim();
  if (override && override.length > 0) return override;
  if (process.env.GATEWAY_ROLE === "central") return GATEWAY_ROLE_FILE;
  return DEFAULT_ROLE_FILE;
}

function resolveIdentityPath(file: string): string {
  return isAbsolute(file) ? file : join(JOELCLAW_DIR, file);
}

function resolveIdentitySpecs(roleFile: string): IdentityFileSpec[] {
  return BASE_IDENTITY_FILES.map((spec) =>
    spec.label === "Role" ? { ...spec, file: roleFile } : spec,
  );
}

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
  path: string;
  content: string;
  size: number;
};

type LoadedIdentityFilesResult = {
  loadedFiles: LoadedIdentityFile[];
  totalChars: number;
  missingFiles: string[];
  truncatedFiles: string[];
  loadTimeMs: number;
  roleFileRequested: string;
  roleFileApplied: string;
};

function loadIdentityFiles(): LoadedIdentityFilesResult {
  const startTime = Date.now();
  const loaded: LoadedIdentityFile[] = [];
  const missingFiles: string[] = [];
  const truncatedFiles: string[] = [];
  let totalChars = 0;

  const roleFileRequested = resolvePreferredRoleFile();
  let roleFileApplied = roleFileRequested;

  for (const spec of resolveIdentitySpecs(roleFileRequested)) {
    const primaryPath = resolveIdentityPath(spec.file);
    let effectiveFile = spec.file;
    let effectivePath = primaryPath;
    let { content, truncated } = readIfExists(primaryPath, spec.maxChars);

    if (!content && spec.label === "Role" && spec.file !== DEFAULT_ROLE_FILE) {
      const fallbackPath = resolveIdentityPath(DEFAULT_ROLE_FILE);
      const fallback = readIfExists(fallbackPath, spec.maxChars);
      if (fallback.content) {
        content = fallback.content;
        truncated = fallback.truncated;
        effectiveFile = DEFAULT_ROLE_FILE;
        effectivePath = fallbackPath;
      }
    }

    if (!content) {
      missingFiles.push(spec.file);
      continue;
    }

    const size = content.length;
    loaded.push({ file: effectiveFile, path: effectivePath, content, size });
    totalChars += size;
    if (truncated) truncatedFiles.push(effectiveFile);
    if (spec.label === "Role") roleFileApplied = effectiveFile;
  }

  return {
    loadedFiles: loaded,
    totalChars,
    missingFiles,
    truncatedFiles,
    loadTimeMs: Date.now() - startTime,
    roleFileRequested,
    roleFileApplied,
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
      roleFileRequested,
      roleFileApplied,
    } = loadIdentityFiles();
    identityBlock = loadIdentityBlock(loadedFiles);
    loaded = true;
    const count = loadedFiles.length;
    console.error(
      `[identity-inject] Loaded ${count} identity files from ${JOELCLAW_DIR} (role=${roleFileApplied}, requested=${roleFileRequested})`,
    );
    void emitOtel("identity-loaded", {
      fileCount: count,
      files: loadedFiles.map(({ file, path, size }) => ({ file, path, size })),
      totalChars,
      missingFiles,
      truncatedFiles,
      loadTimeMs,
      identityDir: JOELCLAW_DIR,
      roleFileRequested,
      roleFileApplied,
      gatewayRole: process.env.GATEWAY_ROLE ?? null,
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
