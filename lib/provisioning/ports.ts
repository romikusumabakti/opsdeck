export const ENTRY_PORT_RANGE = { from: 8100, to: 8999 } as const;

/** Lowest port in the range that is not taken, or null when none is left. */
export function pickFreePort(
  taken: Iterable<number>,
  range: { from: number; to: number } = ENTRY_PORT_RANGE
): number | null {
  const used = new Set(taken);
  for (let port = range.from; port <= range.to; port++) {
    if (!used.has(port)) return port;
  }
  return null;
}
