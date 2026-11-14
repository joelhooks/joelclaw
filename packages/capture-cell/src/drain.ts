import type { Database } from "bun:sqlite";
import { CapturedRowError, classifyFailure } from "./failure";
import type { ShipOtel } from "./otel";
import {
  type DueMarker,
  fold,
  isHandedBack,
  nextDueMarker,
  nextWakeAt,
  readCapturedEntry,
  readCellState,
  readOtelPending,
  WAL_PAUSE_KEY,
  type WalPause,
  writeCellState,
} from "./outbox";
import type { AppendObservation, CapturedPayload, CellEvent, Step } from "./types";

/*
 * The drain runs after each commit, on boot and on a tick. It takes the
 * oldest due marker whose session isn't in flight, runs its step, and
 * folds the outcome in its own transaction. sessions.db has one writer, so
 * one append runs at a time; only the cheap otel steps overlap.
 */

export type WalCheck = { paused: false } | { paused: true; wal_bytes: number; limit_bytes: number };

export interface DrainDeps {
  db: Database;
  now: () => number;
  appendStep: (
    payload: CapturedPayload,
    marker: DueMarker,
  ) => AppendObservation | Promise<AppendObservation>;
  shipOtel: ShipOtel;
  walCheck: () => WalCheck;
  tickMs: number;
  mode?: "off" | "both" | "cell";
  slots?: Partial<Record<Step, number>>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface Drain {
  /** Start any due work now. Safe to call at any time. */
  kick(): void;
  /** Resolve once nothing is in flight and nothing due is left to start. */
  settle(): Promise<void>;
  stop(): void;
}

export function createDrain(deps: DrainDeps): Drain {
  const slots: Record<Step, number> = { append: 1, otel: 4, ...deps.slots };
  const running: Record<Step, number> = { append: 0, otel: 0 };
  const inFlightSessions = new Map<string, number>();
  const active = new Set<Promise<void>>();
  const log =
    deps.log ?? ((message, fields) => console.warn(`[capture-cell] ${message}`, fields ?? {}));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** The WAL guard: append is paused while sessions.db's WAL is over the limit. */
  function appendAllowed(): boolean {
    const check = deps.walCheck();
    const recorded = readCellState<WalPause>(deps.db, WAL_PAUSE_KEY);
    if (check.paused) {
      if (!recorded) {
        const pause: WalPause = {
          since: deps.now(),
          wal_bytes: check.wal_bytes,
          limit_bytes: check.limit_bytes,
          reason: `sessions.db WAL is ${check.wal_bytes} bytes, over the ${check.limit_bytes}-byte stop`,
        };
        writeCellState(deps.db, WAL_PAUSE_KEY, pause, pause.since);
        log("shadowing paused", { ...pause });
      }
      return false;
    }
    if (recorded) {
      writeCellState(deps.db, WAL_PAUSE_KEY, null, deps.now());
      log("shadowing resumed", { paused_since: recorded.since });
    }
    return true;
  }

  async function execute(marker: DueMarker): Promise<CellEvent | null> {
    // The parse and the read are synchronous: yield first, so a kick from
    // the request path never delays the 202.
    await new Promise((resolve) => setImmediate(resolve));
    try {
      if (marker.step === "append") {
        // Handback may have claimed ownership during the initial yield.
        if (isHandedBack(deps.db, marker.run_id)) return null;
        const captured = readCapturedEntry(deps.db, marker.run_id);
        if (!captured) throw new CapturedRowError(`captured row missing for ${marker.run_id}`);
        // A cutover retry can adopt a shadow row during the initial yield.
        // Never settle that newly owed write with the stale shadow marker.
        if (captured.writer && deps.mode !== "cell") return null;
        const observation = await deps.appendStep(captured.payload, {
          ...marker,
          writer: captured.writer ? 1 : 0,
        });
        return {
          type: "step_succeeded",
          run_id: marker.run_id,
          step: "append",
          observation,
          mode: captured.writer ? "cell" : "shadow",
          at: deps.now(),
        };
      }
      for (const pending of readOtelPending(deps.db, marker.run_id)) {
        await deps.shipOtel(pending.event);
      }
      return { type: "step_succeeded", run_id: marker.run_id, step: "otel", at: deps.now() };
    } catch (error) {
      return {
        type: "step_failed",
        run_id: marker.run_id,
        step: marker.step,
        failure: classifyFailure(error),
        at: deps.now(),
      };
    }
  }

  function start(marker: DueMarker): void {
    running[marker.step] += 1;
    inFlightSessions.set(marker.session_key, (inFlightSessions.get(marker.session_key) ?? 0) + 1);
    const task = (async () => {
      const event = await execute(marker);
      if (!event) return;
      if (event.type === "step_failed") {
        log(`step ${marker.step} failed (${event.failure.class})`, {
          run_id: marker.run_id,
          reason: event.failure.reason,
        });
      }
      fold(deps.db, event);
    })()
      .catch((error) =>
        log("fold failed; the marker stays owed", { run_id: marker.run_id, error: String(error) }),
      )
      .finally(() => {
        running[marker.step] -= 1;
        const left = (inFlightSessions.get(marker.session_key) ?? 1) - 1;
        if (left > 0) inFlightSessions.set(marker.session_key, left);
        else inFlightSessions.delete(marker.session_key);
        active.delete(task);
        kick();
      });
    active.add(task);
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    const wakeAt = nextWakeAt(deps.db, deps.mode === "cell");
    const delay =
      wakeAt === null ? deps.tickMs : Math.max(0, Math.min(deps.tickMs, wakeAt - deps.now()));
    timer = setTimeout(kick, Math.max(delay, 10));
  }

  function kick(): void {
    if (stopped) return;
    try {
      let appendChecked: boolean | undefined;
      while (true) {
        const steps = (Object.keys(slots) as Step[]).filter((step) => {
          if (running[step] >= slots[step]) return false;
          if (step !== "append") return true;
          appendChecked ??= appendAllowed();
          return appendChecked;
        });
        const marker = nextDueMarker(
          deps.db,
          deps.now(),
          [...inFlightSessions.keys()],
          steps,
          deps.mode === "cell",
        );
        if (!marker) break;
        start(marker);
      }
    } catch (error) {
      log("drain pass failed", { error: String(error) });
    }
    schedule();
  }

  return {
    kick,
    async settle() {
      kick();
      while (active.size > 0) {
        await Promise.all(active);
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
