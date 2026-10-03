// Server actions serialize Date to string over the wire — TS types still
// claim Date, so accept both at runtime to avoid NaN from .getTime().
function toMs(value: Date | string): number {
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}

/** Compact running time of a run, e.g. "42s" or "2m 5s". */
export function formatElapsed(from: Date | string, now: number): string {
  const ms = Math.max(0, now - toMs(from));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}
