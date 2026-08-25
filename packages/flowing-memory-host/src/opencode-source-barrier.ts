type OpenCodeReadBarrierPoint =
  | "afterCommitBeforeClose"
  | "afterRollbackBeforeClose"
  | "afterSnapshotEstablished";

type OpenCodeReadBarrierHooks = Readonly<Partial<Record<OpenCodeReadBarrierPoint, () => void>>>;

let testHooks: OpenCodeReadBarrierHooks | undefined;

/**
 * Internal test seam for synchronous SQLite interleavings. Hooks receive no
 * database handle, source row, transcript text, or canonical evidence bytes.
 * This module is deliberately absent from the package export surface.
 */
export const withOpenCodeReadBarrierForTest = <Result>(
  hooks: OpenCodeReadBarrierHooks,
  read: () => Result,
): Result => {
  if (testHooks !== undefined) throw new Error("OpenCode read barrier is already active");
  testHooks = hooks;
  try {
    return read();
  } finally {
    testHooks = undefined;
  }
};

export const reachOpenCodeReadBarrier = (point: OpenCodeReadBarrierPoint): void => {
  testHooks?.[point]?.();
};
