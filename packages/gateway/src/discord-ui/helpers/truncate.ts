export function truncate(text: string, max = 220): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;

  const cutoff = Math.max(0, max - 1);
  const soft = clean.lastIndexOf(" ", cutoff);
  if (soft >= Math.floor(max * 0.6)) {
    return `${clean.slice(0, soft)}…`;
  }
  return `${clean.slice(0, cutoff)}…`;
}
