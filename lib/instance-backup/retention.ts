// Which backups to delete. Pure: callers list the backups and delete what
// these return.

export type RetentionKey = { key: string; createdAt: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC calendar day, YYYY-MM-DD. */
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO 8601 week of the UTC date, e.g. "2026-W46". */
function isoWeekOf(d: Date): string {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  // The Thursday of this week decides the ISO year.
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const newestFirst = (keys: RetentionKey[]) =>
  [...keys].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

/**
 * Keeps the newest backup of each of the `keepDaily` most recent days that
 * have one, then the newest of each of the `keepWeekly` most recent older ISO
 * weeks that have no kept daily. Returns the keys to delete, newest first.
 */
export function selectForDeletion(
  keys: RetentionKey[],
  keepDaily: number,
  keepWeekly: number
): string[] {
  const sorted = newestFirst(keys);
  const kept = new Set<string>();

  const days = new Set<string>();
  const weeksWithDaily = new Set<string>();
  let oldestDaily = Number.POSITIVE_INFINITY;
  for (const k of sorted) {
    if (days.size >= keepDaily) break;
    const day = dayOf(k.createdAt);
    if (days.has(day)) continue;
    days.add(day);
    weeksWithDaily.add(isoWeekOf(k.createdAt));
    oldestDaily = k.createdAt.getTime();
    kept.add(k.key);
  }

  const weeks = new Set<string>();
  for (const k of sorted) {
    if (weeks.size >= keepWeekly) break;
    if (k.createdAt.getTime() >= oldestDaily) continue;
    const week = isoWeekOf(k.createdAt);
    if (weeksWithDaily.has(week) || weeks.has(week)) continue;
    weeks.add(week);
    kept.add(k.key);
  }

  return sorted.filter((k) => !kept.has(k.key)).map((k) => k.key);
}

/** Keeps the newest `keep`; returns the keys to delete, newest first. */
export function selectByCount(keys: RetentionKey[], keep: number): string[] {
  return newestFirst(keys)
    .slice(Math.max(keep, 0))
    .map((k) => k.key);
}
