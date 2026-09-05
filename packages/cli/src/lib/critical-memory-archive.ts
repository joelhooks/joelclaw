import { createHash } from "node:crypto"
import { createReadStream, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

export const CRITICAL_MEMORY_ARCHIVE_FILENAME =
  "memory_observations-20260717T203650Z.jsonl"
export const CRITICAL_MEMORY_ARCHIVE_SHA256 =
  "d2f3038d2e2242bffd79aeb0d81d6fa9afa5aa512d2ada1ce0b831c00927db39"

export type CriticalMemoryArchiveSelection = {
  path: string
  expectedSha256?: string
  source: "cli" | "environment" | "frozen-default"
}

export type VerifiedCriticalMemoryArchive = CriticalMemoryArchiveSelection & {
  actualSha256: string
  bytes: number
  filename: string
  verification: "pinned" | "explicit-unpinned"
}

export function frozenCriticalMemoryArchivePath(home = homedir()): string {
  return join(
    home,
    ".joelclaw",
    "search",
    "source-archives",
    CRITICAL_MEMORY_ARCHIVE_FILENAME,
  )
}

export function selectCriticalMemoryArchive(options: {
  cliPath?: string
  cliSha256?: string
  env?: Readonly<Record<string, string | undefined>>
  home?: string
} = {}): CriticalMemoryArchiveSelection {
  const env = options.env ?? process.env
  const home = options.home ?? env.HOME ?? homedir()
  const cliPath = options.cliPath?.trim()
  const environmentPath = (
    env.JOELCLAW_CRITICAL_MEMORY_ARCHIVE ?? env.MEMORY_OBSERVATIONS_ARCHIVE
  )?.trim()
  const path = resolve(
    cliPath || environmentPath || frozenCriticalMemoryArchivePath(home),
  )
  const source = cliPath
    ? "cli"
    : environmentPath
      ? "environment"
      : "frozen-default"
  const explicitSha256 = (
    options.cliSha256 ?? env.JOELCLAW_CRITICAL_MEMORY_ARCHIVE_SHA256
  )?.trim()
  return {
    path,
    expectedSha256:
      explicitSha256 ||
      (source === "frozen-default" ? CRITICAL_MEMORY_ARCHIVE_SHA256 : undefined),
    source,
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolvePromise)
  })
  return hash.digest("hex")
}

export async function verifyCriticalMemoryArchive(
  selection: CriticalMemoryArchiveSelection,
): Promise<VerifiedCriticalMemoryArchive> {
  if (!existsSync(selection.path)) {
    throw new Error(`Memory archive not found: ${selection.path}`)
  }
  const stats = statSync(selection.path)
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`Memory archive is not a non-empty file: ${selection.path}`)
  }
  const actualSha256 = await sha256File(selection.path)
  if (
    selection.expectedSha256 !== undefined &&
    actualSha256 !== selection.expectedSha256
  ) {
    throw new Error(
      `Memory archive checksum mismatch for ${basename(selection.path)}: expected ${selection.expectedSha256}, got ${actualSha256}`,
    )
  }
  return {
    ...selection,
    actualSha256,
    bytes: stats.size,
    filename: basename(selection.path),
    verification:
      selection.expectedSha256 === undefined ? "explicit-unpinned" : "pinned",
  }
}
