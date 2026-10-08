#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type HostName = "flagg" | "blaine";

type HostConfig = {
  name: HostName;
  ssh?: string;
};

type SourceConfig = {
  key: string;
  path: string;
  kind: "dir" | "file";
  required?: boolean;
};

// "skipped" means the walk did not run because a successful rsync already verified the copy.
type StatStatus = "ok" | "missing" | "timeout" | "error" | "skipped";

// How the backup copy was verified: "rsync" = rsync -a --ignore-existing exited 0, so every
// regular source file exists at the destination; "stat" = a walk of the destination finished;
// "none" = not verified (walk timed out or failed, or there was nothing to compare).
type BackupVerification = "rsync" | "stat" | "none";

type RsyncStats = {
  files: number | null;
  transferred: number | null;
  bytes: number | null;
};

type FileStats = {
  status: StatStatus;
  exists: boolean | null;
  files: number | null;
  newest: number | null;
  bytes: number | null;
  error?: string;
};

type SourceReport = {
  key: string;
  path: string;
  exists: boolean | null;
  sourceStatus: StatStatus;
  backupStatus: StatStatus;
  sourceFiles: number | null;
  backupFiles: number | null;
  newestSourceMtimeMs: number | null;
  newestBackupMtimeMs: number | null;
  bytesSource: number | null;
  bytesBackup: number | null;
  sourceStatError?: string;
  backupStatError?: string;
  backupVerification: BackupVerification;
  verified: boolean;
  rsync?: RsyncStats;
  skippedNonRegular?: string[];
  synced: boolean;
  error?: string;
};

type OutboxReport = {
  files: number;
};

type HostReport = {
  host: HostName;
  reachable: boolean;
  repairedEnv: boolean;
  centralHealthOk: boolean;
  centralHealthUrl: string;
  sources: SourceReport[];
  outbox: OutboxReport;
  errors: string[];
};

const hosts: Record<HostName, HostConfig> = {
  flagg: { name: "flagg" },
  blaine: { name: "blaine", ssh: "joel@blaine" },
};

const sources: SourceConfig[] = [
  { key: "pi-agent-sessions", path: "~/.pi/agent/sessions", kind: "dir" },
  { key: "pi-run-history", path: "~/.pi/agent/run-history.jsonl", kind: "file" },
  { key: "pi-notes-events", path: "~/.pi/notes-bridge/events.jsonl", kind: "file" },
  { key: "claude-projects", path: "~/.claude/projects", kind: "dir" },
  { key: "codex-sessions", path: "~/.codex/sessions", kind: "dir" },
  { key: "codex-archived-sessions", path: "~/.codex/archived_sessions", kind: "dir" },
  { key: "codex-session-index", path: "~/.codex/session_index.jsonl", kind: "file" },
  { key: "joelclaw-runs-dev", path: "~/.joelclaw/runs-dev", kind: "dir" },
  { key: "joelclaw-outbox", path: "~/.joelclaw/outbox", kind: "dir" },
];

const args = new Map<string, string | boolean>();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const [rawKey, rawValue] = arg.slice(2).split("=", 2);
  if (rawValue !== undefined) args.set(rawKey, rawValue);
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
    args.set(rawKey, process.argv[++i]);
  else args.set(rawKey, true);
}

const hostList = String(
  args.get("hosts") || process.env.JOELCLAW_SESSION_AUDIT_HOSTS?.trim() || "flagg,blaine",
)
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean) as HostName[];
const unknownHosts = hostList.filter((host) => !Object.hasOwn(hosts, host));
if (unknownHosts.length > 0) {
  throw new Error(
    `Unknown or retired audit host(s): ${unknownHosts.join(", ")}. Known hosts: ${Object.keys(hosts).join(", ")}.`,
  );
}
const backupRoot = String(args.get("backup-root") || "/Volumes/services/joelclaw/sessions");
const centralUrl = String(
  args.get("central-url") || "http://joels-mac-studio.tail7af24.ts.net:3111",
).replace(/\/$/, "");
const repairEnv = Boolean(args.get("repair-env"));
const sync = args.get("sync") !== false && args.get("sync") !== "false";
if (args.has("replay-outbox") || args.has("replay-limit") || args.has("replay-max-bytes")) {
  throw new Error(
    "Outbox replay was removed from this audit. Use scripts/replay-capture-outbox.ts for the canonical prefix-aware replay.",
  );
}
const requestedStatTimeoutMs = Number(args.get("stat-timeout-ms") || 120_000);
const statTimeoutMs =
  Number.isFinite(requestedStatTimeoutMs) && requestedStatTimeoutMs > 0
    ? Math.floor(requestedStatTimeoutMs)
    : 120_000;
const receiptPath = String(
  args.get("receipt") ||
    join(
      backupRoot,
      "receipts",
      `agent-session-audit-${new Date().toISOString().replace(/[:.]/g, "")}.json`,
    ),
);

function run(command: string, options: { timeoutMs?: number; quiet?: boolean } = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const result = spawnSync("/bin/bash", ["-lc", command], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 20,
  });
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  const processError = result.error;
  const processErrorCode =
    processError && "code" in processError ? String(processError.code) : undefined;
  const timedOut = processErrorCode === "ETIMEDOUT";
  return {
    code: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: processError?.message,
    timedOut,
    timeoutMs,
  };
}

function compactError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function describeRunFailure(label: string, result: ReturnType<typeof run>): string {
  const detail = compactError(
    result.error || result.stderr || result.stdout || "no child error output",
  );
  if (result.timedOut) return `${label} timed out after ${result.timeoutMs}ms: ${detail}`;
  return `${label} failed (exit ${result.code}): ${detail}`;
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current} | ${detail}` : detail;
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hostShell(host: HostConfig, command: string, timeoutMs = 60_000) {
  if (!host.ssh) return run(command, { timeoutMs, quiet: true });
  return run(
    `ssh -o BatchMode=yes -o ConnectTimeout=8 ${q(host.ssh)} ${q(`bash -lc ${q(command)}`)}`,
    { timeoutMs, quiet: true },
  );
}

function expandLocal(path: string): string {
  return path.replace(/^~/, process.env.HOME || "/Users/joel");
}

const statPython = `import os, sys\nroot=os.path.expanduser(sys.argv[1])\nif not os.path.exists(root):\n print('MISSING')\n raise SystemExit(0)\nfiles=0; newest=0; total=0\nif os.path.isfile(root):\n st=os.stat(root); files=1; newest=st.st_mtime; total=st.st_size\nelse:\n for dirpath, _, names in os.walk(root):\n  for name in names:\n   p=os.path.join(dirpath,name)\n   if os.path.islink(p): continue\n   try:\n    st=os.stat(p); files += 1; total += st.st_size; newest=max(newest, st.st_mtime)\n   except OSError: pass\nprint(f'{files}\\t{int(newest*1000) if newest else 0}\\t{total}')`;

function parseStatOutput(out: string): FileStats {
  const trimmed = out.trim();
  if (trimmed === "MISSING") {
    return { status: "missing", exists: false, files: 0, newest: null, bytes: 0 };
  }
  const values = trimmed.split("\t").map(Number);
  if (!trimmed || values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    return {
      status: "error",
      exists: null,
      files: null,
      newest: null,
      bytes: null,
      error: `invalid stat output: ${compactError(trimmed || "<empty>")}`,
    };
  }
  const [files, newest, bytes] = values;
  return { status: "ok", exists: true, files, newest: newest || null, bytes };
}

function failedFileStats(label: string, result: ReturnType<typeof run>): FileStats {
  return {
    status: result.timedOut ? "timeout" : "error",
    exists: null,
    files: null,
    newest: null,
    bytes: null,
    error: describeRunFailure(label, result),
  };
}

function statLocalFiles(path: string): FileStats {
  const result = run(`python3 -c ${q(statPython)} ${q(path)}`, {
    timeoutMs: statTimeoutMs,
    quiet: true,
  });
  if (result.code !== 0) return failedFileStats(`local stat ${path}`, result);
  return parseStatOutput(result.stdout);
}

function statRemoteFiles(host: HostConfig, path: string): FileStats {
  const result = hostShell(host, `python3 -c ${q(statPython)} ${q(path)}`, statTimeoutMs);
  if (result.code !== 0) return failedFileStats(`remote stat ${host.name}:${path}`, result);
  return parseStatOutput(result.stdout);
}

function rsyncBinary(): string {
  return existsSync("/opt/homebrew/bin/rsync") ? "/opt/homebrew/bin/rsync" : "rsync";
}

function parseRsyncNumber(output: string, pattern: RegExp): number | null {
  const match = output.match(pattern);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function parseRsyncStats(output: string): RsyncStats {
  return {
    files:
      parseRsyncNumber(output, /Number of files:[^\n]*?reg: ([\d,]+)/) ??
      parseRsyncNumber(output, /Number of files: ([\d,]+)/),
    transferred:
      parseRsyncNumber(output, /Number of regular files transferred: ([\d,]+)/) ??
      parseRsyncNumber(output, /Number of files transferred: ([\d,]+)/),
    bytes: parseRsyncNumber(output, /Total file size: ([\d,]+)/),
  };
}

function parseSkippedNonRegular(output: string): string[] {
  return [...output.matchAll(/^skipping non-regular file "(.*)"$/gm)]
    .map((match) => match[1])
    .slice(0, 50);
}

// --no-links: transcripts are regular files, and a symlink in a transcript tree points at
// project data (for example a Claude project's memory dir) that has its own backup. Copying
// the target would duplicate that data; recreating the link fails on the NAS. Skipped links
// are recorded in the receipt as skippedNonRegular.
function rsyncSource(
  host: HostConfig,
  source: SourceConfig,
  destination: string,
): { ok: boolean; error?: string; stats?: RsyncStats; skippedNonRegular: string[] } {
  mkdirSync(dirname(destination), { recursive: true });
  const srcPath = host.ssh ? source.path : expandLocal(source.path);
  const destArg = source.kind === "dir" ? `${destination}/` : destination;
  const remotePrefix = host.ssh ? `${host.ssh}:` : "";
  const sourceArg =
    source.kind === "dir"
      ? `${remotePrefix}${srcPath.replace(/\/$/, "")}/`
      : `${remotePrefix}${srcPath}`;
  mkdirSync(source.kind === "dir" ? destination : dirname(destination), { recursive: true });
  const cmd = `${q(rsyncBinary())} -a --no-links --ignore-existing --stats ${q(sourceArg)} ${q(destArg)}`;
  const result = run(cmd, { timeoutMs: 30 * 60_000, quiet: true });
  const skippedNonRegular = parseSkippedNonRegular(result.stdout);
  if (result.code !== 0)
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || `rsync exit ${result.code}`,
      skippedNonRegular,
    };
  return { ok: true, stats: parseRsyncStats(result.stdout), skippedNonRegular };
}

function repairCentralEnv(host: HostConfig): boolean {
  const assignment = `export JOELCLAW_CENTRAL_URL=${centralUrl}`;
  const envAssignment = `JOELCLAW_CENTRAL_URL=${centralUrl}`;
  const script = `python3 - <<'PY'\nfrom pathlib import Path\nimport os\ncentral=${JSON.stringify(centralUrl)}\nfiles=[Path.home()/'.zshrc', Path.home()/'.zprofile']\nchanged=False\nfor path in files:\n    if not path.exists():\n        path.write_text(f'export JOELCLAW_CENTRAL_URL={central}\\n')\n        changed=True\n        continue\n    text=path.read_text()\n    lines=text.splitlines()\n    replaced=False\n    for i,line in enumerate(lines):\n        if line.strip().startswith('export JOELCLAW_CENTRAL_URL='):\n            new=f'export JOELCLAW_CENTRAL_URL={central}'\n            if lines[i] != new:\n                lines[i]=new; changed=True\n            replaced=True\n    if not replaced:\n        lines.append(f'export JOELCLAW_CENTRAL_URL={central}'); changed=True\n    if changed:\n        path.write_text('\\n'.join(lines)+'\\n')\nenv=Path.home()/'.config'/'system-bus.env'\nenv.parent.mkdir(parents=True, exist_ok=True)\nif env.exists():\n    text=env.read_text(); lines=text.splitlines(); replaced=False\n    for i,line in enumerate(lines):\n        if line.startswith('JOELCLAW_CENTRAL_URL='):\n            new=f'JOELCLAW_CENTRAL_URL={central}'\n            if lines[i] != new:\n                lines[i]=new; changed=True\n            replaced=True\n    if not replaced:\n        lines.append(f'JOELCLAW_CENTRAL_URL={central}'); changed=True\n    env.write_text('\\n'.join(lines)+'\\n')\nelse:\n    env.write_text(f'JOELCLAW_CENTRAL_URL={central}\\n'); changed=True\nprint('changed' if changed else 'ok')\nPY`;
  const result = hostShell(host, script, 60_000);
  return result.code === 0;
}

function centralHealth(host: HostConfig): boolean {
  const result = hostShell(
    host,
    `curl -fsS --max-time 10 ${q(`${centralUrl}/api/runs/health`)} >/dev/null`,
    20_000,
  );
  return result.code === 0;
}

function countOutbox(host: HostConfig): number {
  const result = hostShell(
    host,
    `find ~/.joelclaw/outbox -type f -name '*.json' 2>/dev/null | wc -l`,
    60_000,
  );
  return Number(result.stdout.trim()) || 0;
}

function inspectOutbox(host: HostConfig): OutboxReport {
  return { files: countOutbox(host) };
}

function auditHost(hostName: HostName): HostReport {
  const host = hosts[hostName];
  const errors: string[] = [];
  const reachable = hostShell(host, "hostname >/dev/null", 20_000).code === 0;
  const repairedEnv = repairEnv ? repairCentralEnv(host) : false;
  const centralHealthOk = centralHealth(host);
  if (!centralHealthOk) errors.push(`central health failed from ${hostName}`);

  const sourceReports: SourceReport[] = [];
  for (const source of sources) {
    const sourceStats = host.ssh
      ? statRemoteFiles(host, source.path)
      : statLocalFiles(expandLocal(source.path));
    const destination = join(backupRoot, hostName, source.key);
    let synced = false;
    let rsyncStats: RsyncStats | undefined;
    let skippedNonRegular: string[] = [];
    let error: string | undefined;
    if (sourceStats.status === "timeout" || sourceStats.status === "error") {
      const detail = `${source.key}: ${sourceStats.error || `source verification ${sourceStats.status}`}`;
      errors.push(detail);
      error = appendError(error, detail);
    }
    if (sync && sourceStats.exists) {
      const result = rsyncSource(host, source, destination);
      synced = result.ok;
      rsyncStats = result.stats;
      skippedNonRegular = result.skippedNonRegular;
      if (result.error) {
        const detail = `${source.key}: ${result.error}`;
        errors.push(detail);
        error = appendError(error, detail);
      }
    }
    // A successful rsync is the verification. Re-walking a large tree on the network mount
    // timed out; walk the destination only when rsync did not run or failed.
    const backupStats: FileStats = synced
      ? { status: "skipped", exists: true, files: null, newest: null, bytes: null }
      : statLocalFiles(destination);
    if (backupStats.status === "timeout" || backupStats.status === "error") {
      const detail = `${source.key}: ${backupStats.error || `backup verification ${backupStats.status}`}`;
      errors.push(detail);
      error = appendError(error, detail);
    }
    if (
      sync &&
      sourceStats.status === "ok" &&
      backupStats.status === "ok" &&
      sourceStats.files !== null &&
      backupStats.files !== null &&
      backupStats.files < sourceStats.files
    ) {
      const detail = `${source.key}: backup has ${backupStats.files}/${sourceStats.files} source files after sync`;
      errors.push(detail);
      error = appendError(error, detail);
    }
    const backupVerification: BackupVerification = synced
      ? "rsync"
      : backupStats.status === "ok" || backupStats.status === "missing"
        ? "stat"
        : "none";
    const verified =
      backupVerification === "rsync" ||
      (backupVerification === "stat" &&
        (sourceStats.status === "missing" ||
          (sourceStats.status === "ok" &&
            backupStats.files !== null &&
            sourceStats.files !== null &&
            backupStats.files >= sourceStats.files)));
    sourceReports.push({
      key: source.key,
      path: source.path,
      exists: sourceStats.exists,
      sourceStatus: sourceStats.status,
      backupStatus: backupStats.status,
      sourceFiles: sourceStats.files,
      backupFiles: backupStats.files,
      newestSourceMtimeMs: sourceStats.newest,
      newestBackupMtimeMs: backupStats.newest,
      bytesSource: sourceStats.bytes,
      bytesBackup: backupStats.bytes,
      ...(sourceStats.error ? { sourceStatError: sourceStats.error } : {}),
      ...(backupStats.error ? { backupStatError: backupStats.error } : {}),
      backupVerification,
      verified,
      ...(rsyncStats ? { rsync: rsyncStats } : {}),
      ...(skippedNonRegular.length > 0 ? { skippedNonRegular } : {}),
      synced,
      ...(error ? { error } : {}),
    });
  }

  const outbox = inspectOutbox(host);
  return {
    host: hostName,
    reachable,
    repairedEnv,
    centralHealthOk,
    centralHealthUrl: `${centralUrl}/api/runs/health`,
    sources: sourceReports,
    outbox,
    errors,
  };
}

mkdirSync(dirname(receiptPath), { recursive: true });
const report = {
  ok: true,
  createdAt: new Date().toISOString(),
  backupRoot,
  centralUrl,
  repairEnv,
  sync,
  statTimeoutMs,
  hosts: hostList.map(auditHost),
};
report.ok = report.hosts.every(
  (host) => host.reachable && host.centralHealthOk && host.errors.length === 0,
);
writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      receiptPath,
      hosts: report.hosts.map((host) => ({
        host: host.host,
        reachable: host.reachable,
        centralHealthOk: host.centralHealthOk,
        outbox: host.outbox,
        errors: host.errors.length,
      })),
    },
    null,
    2,
  ),
);
