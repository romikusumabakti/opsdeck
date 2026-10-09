// The comment box inserts exact display names after `@`, so mentions resolve
// by name without a username scheme. Names are unique among active users, but
// one can contain another ("Ana" and "Ana (ana2)"), so longer names claim
// their text first and a match must end at a word boundary.

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The candidates mentioned in `text`, each once, in candidate order. */
export function resolveMentions<T extends { name: string }>(
  text: string,
  candidates: readonly T[]
): T[] {
  const claimed: [number, number][] = [];
  const overlaps = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && s < end);
  const found = new Set<T>();

  const longestFirst = [...candidates]
    .filter((c) => c.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  for (const candidate of longestFirst) {
    const needle = `@${candidate.name}`;
    for (
      let start = text.indexOf(needle);
      start !== -1;
      start = text.indexOf(needle, start + 1)
    ) {
      const end = start + needle.length;
      if (overlaps(start, end) || WORD_CHAR.test(text.charAt(end))) continue;
      claimed.push([start, end]);
      found.add(candidate);
    }
  }
  return candidates.filter((c) => found.has(c));
}
