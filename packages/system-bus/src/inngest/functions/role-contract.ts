/** Function IDs intentionally registered in more than one worker role. */
export const INTENTIONAL_DUAL_ROLE_IDS = new Set<string>([
  "webhook-subscription-dispatch-generic",
]);

export function findUnexpectedDuplicateIds(ids: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([id, count]) => count > 1 && !INTENTIONAL_DUAL_ROLE_IDS.has(id))
    .map(([id]) => id)
    .sort();
}
