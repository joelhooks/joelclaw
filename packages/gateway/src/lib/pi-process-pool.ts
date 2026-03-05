/**
 * ADR-0209: Warm pi process pool for sub-second inference.
 *
 * Keeps a pre-spawned `pi -p --no-session --no-extensions` process
 * ready to accept prompts. When a prompt arrives, pipes it to the
 * already-warm process (eliminating 3-4s cold-start), reads the
 * response, and immediately spawns a replacement.
 *
 * "Pool of 1" pattern — the replacement warms while the caller
 * processes the response, so the next call is also instant.
 *
 * Usage:
 *   const pool = createPiProcessPool({ model: "anthropic/claude-haiku-4-5" });
 *   const result = await pool.infer("classify this message");
 *   pool.shutdown();
 */

import { spawn } from "node:child_process";

export interface PiProcessPoolOptions {
  /** Model to use (default: anthropic/claude-haiku-4-5) */
  model?: string;
  /** Response timeout in ms (default: 6000) */
  timeoutMs?: number;
  /** Max idle time before recycling the warm process (default: 5min) */
  maxIdleMs?: number;
  /** On spawn/recycle/error events */
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

interface WarmProcess {
  proc: ReturnType<typeof spawn>;
  spawnedAt: number;
  pid: number;
}

export interface PiProcessPool {
  /** Send a prompt and get the response. Uses the warm process if available. */
  infer: (prompt: string) => Promise<string>;
  /** Shut down the pool and kill any warm process. */
  shutdown: () => void;
  /** Current pool stats. */
  stats: () => { warm: boolean; spawns: number; infers: number; timeouts: number; avgMs: number };
}

export function createPiProcessPool(options: PiProcessPoolOptions = {}): PiProcessPool {
  const model = options.model ?? "anthropic/claude-haiku-4-5";
  const timeoutMs = options.timeoutMs ?? 6000;
  const maxIdleMs = options.maxIdleMs ?? 5 * 60 * 1000;
  const onEvent = options.onEvent ?? (() => {});

  let warm: WarmProcess | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let shutdownRequested = false;

  // Stats
  let spawns = 0;
  let infers = 0;
  let timeouts = 0;
  let totalMs = 0;

  function spawnWarm(): WarmProcess | null {
    if (shutdownRequested) return null;

    try {
      const proc = spawn("pi", ["-p", "--no-session", "--no-extensions", "--model", model], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Don't let the warm process keep the event loop alive
      proc.unref();

      spawns++;
      const wp: WarmProcess = { proc, spawnedAt: Date.now(), pid: proc.pid ?? 0 };

      onEvent("spawn", { pid: wp.pid, spawns });

      // If process exits unexpectedly while warm, respawn
      (proc as unknown as NodeJS.EventEmitter).on("exit", () => {
        if (warm?.proc === proc) {
          warm = null;
          onEvent("warm.exited", { pid: wp.pid });
          // Respawn after a brief delay
          setTimeout(() => { if (!shutdownRequested) warm = spawnWarm(); }, 500);
        }
      });

      // Reset idle timer
      resetIdleTimer();

      return wp;
    } catch (err) {
      onEvent("spawn.failed", { error: String(err) });
      return null;
    }
  }

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (warm) {
        onEvent("idle.recycle", { pid: warm.pid, idleMs: maxIdleMs });
        warm.proc.kill();
        warm = null;
        // Respawn fresh
        warm = spawnWarm();
      }
    }, maxIdleMs);
  }

  async function infer(prompt: string): Promise<string> {
    const startMs = Date.now();

    // Grab warm process or spawn cold
    let wp = warm;
    warm = null; // Claim it — no one else gets it

    if (!wp || wp.proc.killed || wp.proc.exitCode !== null) {
      onEvent("cold.start", {});
      wp = spawnWarm();
      if (!wp) throw new Error("Failed to spawn pi process");
    } else {
      onEvent("warm.used", { pid: wp.pid, warmMs: Date.now() - wp.spawnedAt });
    }

    // Immediately spawn replacement (warms while we wait for response)
    if (!shutdownRequested) {
      warm = spawnWarm();
    }

    return new Promise<string>((resolve, reject) => {
      const { proc } = wp!;
      const chunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          timeouts++;
          proc.kill();
          onEvent("timeout", { pid: wp!.pid, timeoutMs });
          reject(new Error(`pi process timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      proc.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));

      (proc as unknown as NodeJS.EventEmitter).on("exit", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const elapsed = Date.now() - startMs;
          totalMs += elapsed;
          infers++;
          const result = Buffer.concat(chunks).toString("utf-8").trim();
          onEvent("infer.complete", { pid: wp!.pid, elapsed, resultLength: result.length });
          resolve(result);
        }
      });

      (proc as unknown as NodeJS.EventEmitter).on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      // Write prompt and close stdin to signal EOF
      proc.stdin!.write(prompt);
      proc.stdin!.end();
    });
  }

  function shutdown(): void {
    shutdownRequested = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (warm) {
      warm.proc.kill();
      warm = null;
    }
    onEvent("shutdown", { spawns, infers, timeouts });
  }

  function stats() {
    return {
      warm: warm !== null && !warm.proc.killed && warm.proc.exitCode === null,
      spawns,
      infers,
      timeouts,
      avgMs: infers > 0 ? Math.round(totalMs / infers) : 0,
    };
  }

  // Initial spawn
  warm = spawnWarm();

  return { infer, shutdown, stats };
}
