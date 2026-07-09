#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type HostName = "flagg" | "blaine" | "panda";

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

type SourceReport = {
  key: string;
  path: string;
  exists: boolean;
  sourceFiles: number;
  backupFiles: number;
  newestSourceMtimeMs: number | null;
  newestBackupMtimeMs: number | null;
  bytesSource: number;
  bytesBackup: number;
  synced: boolean;
  error?: string;
};

type HostReport = {
  host: HostName;
  reachable: boolean;
  repairedEnv: boolean;
  centralHealthOk: boolean;
  centralHealthUrl: string;
  sources: SourceReport[];
  outbox: {
    before: number;
    replayAttempted: number;
    replayed: number;
    failed: number;
    after: number;
  };
  errors: string[];
};

const hosts: Record<HostName, HostConfig> = {
  flagg: { name: "flagg" },
  blaine: { name: "blaine", ssh: "joel@blaine" },
  panda: { name: "panda", ssh: "joel@panda" },
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
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) args.set(rawKey, process.argv[++i]);
  else args.set(rawKey, true);
}

const hostList = String(args.get("hosts") || "flagg,blaine,panda")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean) as HostName[];
const backupRoot = String(args.get("backup-root") || "/Volumes/three-body/sessions");
const centralUrl = String(args.get("central-url") || "http://joels-mac-studio.tail7af24.ts.net:3111").replace(/\/$/, "");
const repairEnv = Boolean(args.get("repair-env"));
const sync = args.get("sync") !== false && args.get("sync") !== "false";
const replayOutbox = Boolean(args.get("replay-outbox"));
const replayLimit = Number(args.get("replay-limit") || 0);
const replayMaxBytes = Number(args.get("replay-max-bytes") || 10 * 1024 * 1024);
const receiptPath = String(args.get("receipt") || join(backupRoot, "receipts", `agent-session-audit-${new Date().toISOString().replace(/[:.]/g, "")}.json`));

function run(command: string, options: { timeoutMs?: number; quiet?: boolean } = {}) {
  const result = spawnSync("/bin/bash", ["-lc", command], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 1024 * 1024 * 20,
  });
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hostShell(host: HostConfig, command: string, timeoutMs = 60_000) {
  if (!host.ssh) return run(command, { timeoutMs, quiet: true });
  return run(`ssh -o BatchMode=yes -o ConnectTimeout=8 ${q(host.ssh)} ${q(`bash -lc ${q(command)}`)}`, { timeoutMs, quiet: true });
}

function expandLocal(path: string): string {
  return path.replace(/^~/, process.env.HOME || "/Users/joel");
}

const statPython = `import os, sys\nroot=os.path.expanduser(sys.argv[1])\nif not os.path.exists(root):\n print('MISSING')\n raise SystemExit(0)\nfiles=0; newest=0; total=0\nif os.path.isfile(root):\n st=os.stat(root); files=1; newest=st.st_mtime; total=st.st_size\nelse:\n for dirpath, _, names in os.walk(root):\n  for name in names:\n   p=os.path.join(dirpath,name)\n   try:\n    st=os.stat(p); files += 1; total += st.st_size; newest=max(newest, st.st_mtime)\n   except OSError: pass\nprint(f'{files}\\t{int(newest*1000) if newest else 0}\\t{total}')`;

function parseStatOutput(out: string): { exists: boolean; files: number; newest: number | null; bytes: number } {
  const trimmed = out.trim();
  if (!trimmed || trimmed === "MISSING") return { exists: false, files: 0, newest: null, bytes: 0 };
  const [files, newest, bytes] = trimmed.split("\t").map(Number);
  return { exists: true, files: files || 0, newest: newest ? newest : null, bytes: bytes || 0 };
}

function statLocalFiles(path: string): { exists: boolean; files: number; newest: number | null; bytes: number } {
  const result = run(`python3 -c ${q(statPython)} ${q(path)}`, { timeoutMs: 120_000, quiet: true });
  if (result.code !== 0) return { exists: false, files: 0, newest: null, bytes: 0 };
  return parseStatOutput(result.stdout);
}

function statRemoteFiles(host: HostConfig, path: string): { exists: boolean; files: number; newest: number | null; bytes: number } {
  const result = hostShell(host, `python3 -c ${q(statPython)} ${q(path)}`, 120_000);
  if (result.code !== 0) return { exists: false, files: 0, newest: null, bytes: 0 };
  return parseStatOutput(result.stdout);
}

function rsyncBinary(): string {
  return existsSync("/opt/homebrew/bin/rsync") ? "/opt/homebrew/bin/rsync" : "rsync";
}

function rsyncSource(host: HostConfig, source: SourceConfig, destination: string): { ok: boolean; error?: string } {
  mkdirSync(dirname(destination), { recursive: true });
  const srcPath = host.ssh ? source.path : expandLocal(source.path);
  const destArg = source.kind === "dir" ? `${destination}/` : destination;
  const remotePrefix = host.ssh ? `${host.ssh}:` : "";
  const sourceArg = source.kind === "dir" ? `${remotePrefix}${srcPath.replace(/\/$/, "")}/` : `${remotePrefix}${srcPath}`;
  mkdirSync(source.kind === "dir" ? destination : dirname(destination), { recursive: true });
  const cmd = `${q(rsyncBinary())} -a --ignore-existing ${q(sourceArg)} ${q(destArg)}`;
  const result = run(cmd, { timeoutMs: 30 * 60_000, quiet: true });
  if (result.code !== 0) return { ok: false, error: result.stderr.trim() || result.stdout.trim() || `rsync exit ${result.code}` };
  return { ok: true };
}

function repairCentralEnv(host: HostConfig): boolean {
  const assignment = `export JOELCLAW_CENTRAL_URL=${centralUrl}`;
  const envAssignment = `JOELCLAW_CENTRAL_URL=${centralUrl}`;
  const script = `python3 - <<'PY'\nfrom pathlib import Path\nimport os\ncentral=${JSON.stringify(centralUrl)}\nfiles=[Path.home()/'.zshrc', Path.home()/'.zprofile']\nchanged=False\nfor path in files:\n    if not path.exists():\n        path.write_text(f'export JOELCLAW_CENTRAL_URL={central}\\n')\n        changed=True\n        continue\n    text=path.read_text()\n    lines=text.splitlines()\n    replaced=False\n    for i,line in enumerate(lines):\n        if line.strip().startswith('export JOELCLAW_CENTRAL_URL='):\n            new=f'export JOELCLAW_CENTRAL_URL={central}'\n            if lines[i] != new:\n                lines[i]=new; changed=True\n            replaced=True\n    if not replaced:\n        lines.append(f'export JOELCLAW_CENTRAL_URL={central}'); changed=True\n    if changed:\n        path.write_text('\\n'.join(lines)+'\\n')\nenv=Path.home()/'.config'/'system-bus.env'\nenv.parent.mkdir(parents=True, exist_ok=True)\nif env.exists():\n    text=env.read_text(); lines=text.splitlines(); replaced=False\n    for i,line in enumerate(lines):\n        if line.startswith('JOELCLAW_CENTRAL_URL='):\n            new=f'JOELCLAW_CENTRAL_URL={central}'\n            if lines[i] != new:\n                lines[i]=new; changed=True\n            replaced=True\n    if not replaced:\n        lines.append(f'JOELCLAW_CENTRAL_URL={central}'); changed=True\n    env.write_text('\\n'.join(lines)+'\\n')\nelse:\n    env.write_text(f'JOELCLAW_CENTRAL_URL={central}\\n'); changed=True\nprint('changed' if changed else 'ok')\nPY`;
  const result = hostShell(host, script, 60_000);
  return result.code === 0;
}

function centralHealth(host: HostConfig): boolean {
  const result = hostShell(host, `curl -fsS --max-time 10 ${q(`${centralUrl}/api/runs/health`)} >/dev/null`, 20_000);
  return result.code === 0;
}

function countOutbox(host: HostConfig): number {
  const result = hostShell(host, `find ~/.joelclaw/outbox -type f -name '*.json' 2>/dev/null | wc -l`, 60_000);
  return Number(result.stdout.trim()) || 0;
}

function replayOutboxForHost(host: HostConfig): HostReport["outbox"] {
  const before = countOutbox(host);
  if (!replayOutbox || replayLimit <= 0 || before === 0) {
    return { before, replayAttempted: 0, replayed: 0, failed: 0, after: before };
  }
  const script = `python3 - <<'PY'\nimport json, os, sys, urllib.request, pathlib, shutil\nlimit=int(os.environ.get('REPLAY_LIMIT','0'))\nmax_bytes=int(os.environ.get('REPLAY_MAX_BYTES','10485760'))\ncentral=os.environ['CENTRAL_URL'].rstrip('/')\nauth_path=pathlib.Path.home()/'.joelclaw'/'auth.json'\nif not auth_path.exists():\n print(json.dumps({'attempted':0,'replayed':0,'failed':0,'skippedLarge':0,'error':'missing auth'})); raise SystemExit(0)\ntoken=json.loads(auth_path.read_text()).get('token')\nroot=pathlib.Path.home()/'.joelclaw'/'outbox'\nsent=pathlib.Path.home()/'.joelclaw'/'outbox-sent'\nsent.mkdir(parents=True, exist_ok=True)\nattempted=replayed=failed=skipped=0\nfiles=sorted(root.glob('*.json'), key=lambda p: (p.stat().st_size, p.stat().st_mtime))\nfor path in files:\n if attempted>=limit: break\n try:\n  if max_bytes > 0 and path.stat().st_size > max_bytes:\n   skipped += 1\n   continue\n except OSError:\n  continue\n attempted+=1\n try:\n  body=path.read_bytes()\n  req=urllib.request.Request(central+'/api/runs', data=body, method='POST', headers={'content-type':'application/json','authorization':'Bearer '+token})\n  with urllib.request.urlopen(req, timeout=60) as res:\n   ok=200 <= res.status < 300\n  if ok:\n   shutil.move(str(path), str(sent/path.name)); replayed+=1\n  else: failed+=1\n except Exception:\n  failed+=1\nprint(json.dumps({'attempted':attempted,'replayed':replayed,'failed':failed,'skippedLarge':skipped,'maxBytes':max_bytes}))\nPY`;
  const envPrefix = `CENTRAL_URL=${q(centralUrl)} REPLAY_LIMIT=${q(String(replayLimit))} REPLAY_MAX_BYTES=${q(String(replayMaxBytes))}`;
  const result = hostShell(host, `${envPrefix} ${script}`, Math.max(60_000, replayLimit * 35_000));
  let attempted = 0;
  let replayed = 0;
  let failed = 0;
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}");
    attempted = Number(parsed.attempted) || 0;
    replayed = Number(parsed.replayed) || 0;
    failed = Number(parsed.failed) || 0;
  } catch {
    failed = replayLimit;
  }
  const after = countOutbox(host);
  return { before, replayAttempted: attempted, replayed, failed, after };
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
    const sourceStats = host.ssh ? statRemoteFiles(host, source.path) : statLocalFiles(expandLocal(source.path));
    const destination = join(backupRoot, hostName, source.key);
    let synced = false;
    let error: string | undefined;
    if (sync && sourceStats.exists) {
      const result = rsyncSource(host, source, destination);
      synced = result.ok;
      error = result.error;
      if (error) errors.push(`${source.key}: ${error}`);
    }
    const backupStats = statLocalFiles(destination);
    if (sync && sourceStats.exists && backupStats.files < sourceStats.files) {
      const detail = `${source.key}: backup has ${backupStats.files}/${sourceStats.files} source files after sync`;
      errors.push(detail);
      error = error ? `${error} | ${detail}` : detail;
    }
    sourceReports.push({
      key: source.key,
      path: source.path,
      exists: sourceStats.exists,
      sourceFiles: sourceStats.files,
      backupFiles: backupStats.files,
      newestSourceMtimeMs: sourceStats.newest,
      newestBackupMtimeMs: backupStats.newest,
      bytesSource: sourceStats.bytes,
      bytesBackup: backupStats.bytes,
      synced,
      error,
    });
  }

  const outbox = replayOutboxForHost(host);
  if (replayOutbox && outbox.after > 0) {
    errors.push(`joelclaw-outbox: ${outbox.after} files remain after bounded replay`);
  }
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
  replayOutbox,
  replayLimit,
  replayMaxBytes,
  hosts: hostList.map(auditHost),
};
report.ok = report.hosts.every((host) => host.reachable && host.centralHealthOk && host.errors.length === 0);
writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: report.ok, receiptPath, hosts: report.hosts.map((host) => ({ host: host.host, reachable: host.reachable, centralHealthOk: host.centralHealthOk, outbox: host.outbox, errors: host.errors.length })) }, null, 2));
