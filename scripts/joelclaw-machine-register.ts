#!/usr/bin/env bun
/**
 * joelclaw-machine-register — register THIS Machine with Central.
 *
 * ADR-0243 Phase 3 minting flow (single-user scope for now):
 *   1. Use the caller's already-authenticated PDS session (joelclaw pds
 *      session) to call com.atproto.server.createAppPassword with the
 *      given name. Returns the plaintext App Password once.
 *   2. Compute sha256(appPassword) and upsert a row in Typesense
 *      `machines_dev` linking (did, handle, app_password_sha256,
 *      machine_id, user_id, machine_name).
 *   3. Write/overwrite ~/.joelclaw/auth.json with the new token so
 *      future POST /api/runs calls use it.
 *   4. Back up the previous auth.json to ~/.joelclaw/auth.json.bak.
 *
 * The App Password plaintext is displayed on-screen once and NEVER
 * written to disk outside auth.json. Central only ever stores the
 * hash.
 *
 * Usage:
 *   joelclaw-machine-register --name panda
 *   joelclaw-machine-register --name dark-wizard --user joel
 *
 * Flags:
 *   --name <x>       machine name (required — appears in pi/claude-code
 *                    tags and in the PDS App Passwords list)
 *   --user <x>       user alias (default: joel)
 *   --privileged     mint a privileged App Password (default false —
 *                    restricted perms, which is what we want)
 *   --no-write-auth  don't overwrite ~/.joelclaw/auth.json (dry-run
 *                    mode — just print the token)
 *
 * Requires the system-bus worker or any process that can call into
 * @joelclaw/system-bus/lib/pds to already have a valid PDS session
 * (joelclaw pds session runs on-demand; the system-bus worker refreshes
 * in the background).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MACHINES_COLLECTION, machinesSchema } from "../packages/memory/src/index";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:9627";
const PDS_SESSION_PATH = join(homedir(), ".joelclaw", "pds-session.json");

interface CachedPdsSession {
  accessJwt: string;
  did: string;
  handle: string;
}

function loadPdsSession(): CachedPdsSession {
  if (!existsSync(PDS_SESSION_PATH)) {
    throw new Error(
      `PDS session not found at ${PDS_SESSION_PATH}. Run 'joelclaw pds session' first.`
    );
  }
  const data = JSON.parse(readFileSync(PDS_SESSION_PATH, "utf8"));
  if (!data.accessJwt || !data.did || !data.handle) {
    throw new Error(`PDS session at ${PDS_SESSION_PATH} is missing accessJwt/did/handle`);
  }
  return { accessJwt: data.accessJwt, did: data.did, handle: data.handle };
}

async function pdsCreateAppPassword(params: {
  accessJwt: string;
  name: string;
  privileged?: boolean;
}): Promise<{ name: string; password: string; createdAt: string }> {
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAppPassword`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.accessJwt}`,
    },
    body: JSON.stringify({ name: params.name, privileged: params.privileged ?? false }),
  });
  if (!res.ok) {
    throw new Error(`PDS createAppPassword ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { name: string; password: string; createdAt: string };
}

interface Args {
  name: string;
  user: string;
  privileged: boolean;
  writeAuth: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { name: "", user: "joel", privileged: false, writeAuth: true };
  for (const arg of argv) {
    if (arg.startsWith("--name=")) out.name = arg.slice(7);
    else if (arg === "--name") out.name = argv[argv.indexOf(arg) + 1] ?? "";
    else if (arg.startsWith("--user=")) out.user = arg.slice(7);
    else if (arg === "--privileged") out.privileged = true;
    else if (arg === "--no-write-auth") out.writeAuth = false;
  }
  return out;
}

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY;
if (!TYPESENSE_API_KEY) {
  console.error("TYPESENSE_API_KEY required");
  process.exit(1);
}

async function ensureMachinesCollection(): Promise<void> {
  const res = await fetch(`${TYPESENSE_URL}/collections/${MACHINES_COLLECTION}`, {
    headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY as string },
  });
  if (res.status === 200) return;
  if (res.status !== 404) {
    throw new Error(`typesense ${res.status}: ${await res.text()}`);
  }
  const createRes = await fetch(`${TYPESENSE_URL}/collections`, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY as string,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(machinesSchema()),
  });
  if (!createRes.ok) {
    throw new Error(`create ${MACHINES_COLLECTION} failed: ${await createRes.text()}`);
  }
  console.log(`✓ created Typesense collection ${MACHINES_COLLECTION}`);
}

async function upsertMachine(params: {
  machineId: string;
  userId: string;
  did: string;
  handle: string;
  machineName: string;
  appPasswordName: string;
  appPasswordSha256: string;
}): Promise<void> {
  const doc = {
    id: params.machineId,
    user_id: params.userId,
    did: params.did,
    handle: params.handle,
    machine_name: params.machineName,
    app_password_name: params.appPasswordName,
    app_password_sha256: params.appPasswordSha256,
    created_at: Date.now(),
    last_seen_at: Date.now(),
  };
  const res = await fetch(
    `${TYPESENSE_URL}/collections/${MACHINES_COLLECTION}/documents?action=upsert`,
    {
      method: "POST",
      headers: {
        "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY as string,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(doc),
    }
  );
  if (!res.ok) {
    throw new Error(`upsert Machine failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) {
    console.error("usage: joelclaw-machine-register --name <machine-name> [--user joel]");
    process.exit(1);
  }

  console.log(`registering machine=${args.name} user=${args.user} privileged=${args.privileged}`);

  await ensureMachinesCollection();

  // Load existing PDS session (refresh via `joelclaw pds session` if stale).
  const pds = loadPdsSession();

  // Mint App Password at PDS.
  const appPasswordLabel = `joelclaw-memory-${args.name}-${Date.now().toString(36)}`;
  const pdsResult = await pdsCreateAppPassword({
    accessJwt: pds.accessJwt,
    name: appPasswordLabel,
    privileged: args.privileged,
  });
  const { password: plaintext, name: issuedName } = pdsResult;
  const { did, handle } = pds;

  const hash = createHash("sha256").update(plaintext).digest("hex");
  const machineId = args.name;

  await upsertMachine({
    machineId,
    userId: args.user,
    did,
    handle,
    machineName: args.name,
    appPasswordName: issuedName,
    appPasswordSha256: hash,
  });

  console.log("✓ Machine row upserted in Typesense");
  console.log("");
  console.log("identity:");
  console.log(`  did:          ${did}`);
  console.log(`  handle:       ${handle}`);
  console.log(`  user_id:      ${args.user}`);
  console.log(`  machine_id:   ${machineId}`);
  console.log(`  app_password_name: ${issuedName}`);
  console.log("");

  if (args.writeAuth) {
    const authPath = join(homedir(), ".joelclaw", "auth.json");
    const backupPath = `${authPath}.bak`;
    if (existsSync(authPath)) {
      copyFileSync(authPath, backupPath);
      console.log(`  previous auth.json backed up to ${backupPath}`);
    }
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify(
        {
          user_id: args.user,
          machine_id: machineId,
          token: plaintext,
          did,
          handle,
          app_password_name: issuedName,
          issued_at: new Date().toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    console.log(`  wrote ${authPath} (0600)`);
  } else {
    console.log("  --no-write-auth set; not touching auth.json");
    console.log("  App Password (store it somewhere safe):");
    console.log(`  ${plaintext}`);
  }
  console.log("");
  console.log("next: hit POST /api/runs with the new bearer to verify.");
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
