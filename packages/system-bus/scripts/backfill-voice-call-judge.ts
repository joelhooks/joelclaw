#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import matter from "gray-matter";
import { inngest } from "../src/inngest/client";
import { JUDGE_VERSION } from "../src/inngest/functions/voice-call-judge";

const VOICE_DIR = process.env.VOICE_TRANSCRIPT_DIR?.trim() || join(homedir(), ".joelclaw/workspace/memory/voice");
const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : Number.POSITIVE_INFINITY;

const sessionDetail = makeFunctionReference<
  "query",
  { room: string },
  { analysis: { judgeStatus?: string; scores?: { judgeVersion?: string } } | null } | null
>("calls:sessionDetail");

function convexClient(): ConvexHttpClient {
  const url = process.env.CONVEX_URL?.trim() || "http://127.0.0.1:3210";
  const client = new ConvexHttpClient(url);
  const adminKey = process.env.CONVEX_ADMIN_KEY?.trim();
  if (adminKey) client.setAuth(adminKey);
  return client;
}

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function tierFromFrontmatter(type: unknown): "private" | "public" | "guest" | "synthetic" | null {
  if (type === "voice-call-public") return "public";
  if (type === "voice-call-guest") return "guest";
  if (type === "voice-call-synthetic") return "synthetic";
  if (type === "voice-call") return "private";
  return null;
}

const files = [...new Bun.Glob("**/*.md").scanSync({ cwd: VOICE_DIR, absolute: true })].sort();
const client = convexClient();
const candidates: Array<{
  file: string;
  room: string;
  transcript: string;
  tier: "private" | "public" | "guest" | "synthetic";
  duration: number;
  turns: number;
  timestamp?: string;
}> = [];

for (const file of files) {
  const parsed = matter(await Bun.file(file).text());
  const tier = tierFromFrontmatter(parsed.data.type);
  const room = typeof parsed.data.room === "string" ? parsed.data.room.trim() : "";
  const transcript = parsed.content.trim();
  if (!tier || !room || !transcript) continue;

  const detail = await client.query(sessionDetail, { room });
  if (detail?.analysis?.judgeStatus === "done" && detail.analysis.scores?.judgeVersion === JUDGE_VERSION) continue;

  candidates.push({
    file,
    room,
    transcript,
    tier,
    duration: finiteNumber(parsed.data.duration_s ?? parsed.data.duration),
    turns: transcript.match(/^\*\*(?:Joel|Caller|ShitRat)\*\*:/gmu)?.length ?? 0,
    timestamp: typeof parsed.data.date === "string" ? parsed.data.date : undefined,
  });
  if (candidates.length >= limit) break;
}

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", scanned: files.length, pending: candidates.length }, null, 2));
  console.log("Re-run with --apply to emit voice/call.judge.requested events.");
  process.exit(0);
}

let emitted = 0;
for (const candidate of candidates) {
  await inngest.send({
    id: `voice-call-judge-backfill-${candidate.room}-${candidate.timestamp ?? "unknown"}`,
    name: "voice/call.judge.requested",
    data: {
      transcript: candidate.transcript,
      room: candidate.room,
      tier: candidate.tier,
      duration: candidate.duration,
      turns: candidate.turns,
      timestamp: candidate.timestamp,
    },
  });
  emitted += 1;
}

console.log(JSON.stringify({ mode: "apply", scanned: files.length, pending: candidates.length, emitted }, null, 2));
