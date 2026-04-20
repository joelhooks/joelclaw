/**
 * ADR-0243 Rule 20 auth middleware for the memory API.
 *
 * Wire protocol: `Authorization: Bearer <app-password-plaintext>`.
 * Hot path: sha256(token) → Typesense `machines_dev` lookup →
 *   { user_id, machine_id, did }. No PDS roundtrip per request.
 *
 * App Password validity is established at Machine register time
 * (via pdsValidateAppPassword); the plaintext-hash serves as the
 * identity key thereafter. Revocation marks the Machine row
 * `revoked_at` (and also calls pdsRevokeAppPassword for defense in
 * depth against someone bypassing us and hitting PDS directly).
 *
 * Dev bearer fallback: `MEMORY_DEV_BEARER_TOKENS` env var lets us
 * continue testing with a hardcoded token during the transition. In
 * production, set it to an empty JSON object and real App Passwords
 * take over.
 *
 * Phase 3.5 TODO:
 *   - Replace hardcoded DID→user_id map with a `users_dev` collection
 *   - Cache Typesense lookups in-process for ~60s (low hanging)
 *   - Bump last_seen_at on successful auth (async; fire-and-forget)
 */
import { createHash } from "node:crypto";
import { MACHINES_COLLECTION } from "@joelclaw/memory";
import type { NextRequest } from "next/server";

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";

const DEV_BEARER_TOKENS: Record<string, { user_id: string; machine_id: string; did?: string }> =
  (() => {
    const raw = process.env.MEMORY_DEV_BEARER_TOKENS;
    if (!raw) {
      return {
        "dev-joel-panda": {
          user_id: "joel",
          machine_id: "panda",
          did: "did:plc:5w6ablyvahugobsj7n57yjmm",
        },
      };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

// Phase 3.5: replace with users_dev collection lookup.
const DID_TO_USER_ID: Record<string, string> = {
  "did:plc:5w6ablyvahugobsj7n57yjmm": "joel",
};

export interface MemoryIdentity {
  user_id: string;
  machine_id: string;
  did: string | null;
  source: "dev-bearer" | "app-password";
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function lookupMachineByAppPasswordHash(
  hash: string
): Promise<MemoryIdentity | null> {
  const params = new URLSearchParams({
    q: hash,
    query_by: "app_password_sha256",
    filter_by: `app_password_sha256:=\`${hash}\``,
    per_page: "1",
  });
  const res = await fetch(
    `${TYPESENSE_URL}/collections/${MACHINES_COLLECTION}/documents/search?${params}`,
    {
      headers: { "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY },
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    hits?: Array<{
      document: {
        id: string;
        user_id: string;
        did: string;
        revoked_at?: number;
      };
    }>;
  };
  const hit = data.hits?.[0]?.document;
  if (!hit) return null;
  if (hit.revoked_at) return null;
  return {
    user_id: hit.user_id,
    machine_id: hit.id,
    did: hit.did,
    source: "app-password",
  };
}

export async function authenticateMemoryRequest(
  request: NextRequest
): Promise<MemoryIdentity | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;

  // Dev bearer path — used for local testing until every Machine has
  // been registered with an App Password. When MEMORY_DEV_BEARER_TOKENS
  // is empty in production, this branch effectively disappears.
  const dev = DEV_BEARER_TOKENS[token];
  if (dev) {
    return {
      user_id: dev.user_id,
      machine_id: dev.machine_id,
      did: dev.did ?? null,
      source: "dev-bearer",
    };
  }

  // App Password path — hash the token, look up the Machine row.
  const hash = sha256(token);
  const identity = await lookupMachineByAppPasswordHash(hash);
  if (!identity) return null;

  // Phase 3.5: reconcile did → user_id from users_dev. For now, trust
  // the Machine row's user_id field (which we set at register time).
  if (identity.did && DID_TO_USER_ID[identity.did]) {
    return { ...identity, user_id: DID_TO_USER_ID[identity.did]! };
  }

  return identity;
}
