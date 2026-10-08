export type DependencyFailureLatchSnapshot =
  | { _tag: "Closed" }
  | { _tag: "Open"; retryAtMs: number; reason: string };

export type DependencyFailureLatch = {
  read(): DependencyFailureLatchSnapshot;
  trip(reason: string): Extract<DependencyFailureLatchSnapshot, { _tag: "Open" }>;
  reset(): void;
};

export function createDependencyFailureLatch(options: {
  cooldownMs: number;
  now?: () => number;
}): DependencyFailureLatch {
  if (!Number.isSafeInteger(options.cooldownMs) || options.cooldownMs <= 0) {
    throw new Error("dependency latch cooldownMs must be a positive safe integer");
  }

  const now = options.now ?? Date.now;
  let snapshot: DependencyFailureLatchSnapshot = { _tag: "Closed" };
  const read = (): DependencyFailureLatchSnapshot => {
    if (snapshot._tag === "Open" && now() >= snapshot.retryAtMs) {
      snapshot = { _tag: "Closed" };
    }
    return snapshot;
  };

  return {
    read,
    trip(reason) {
      const current = read();
      if (current._tag === "Open") return current;
      snapshot = { _tag: "Open", retryAtMs: now() + options.cooldownMs, reason };
      return snapshot;
    },
    reset() {
      snapshot = { _tag: "Closed" };
    },
  };
}
