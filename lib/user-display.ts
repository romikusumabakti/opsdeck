// Pure helpers for rendering a user's identity. No server-only imports: the
// avatar, card and directory components use these on the client too.

export type WorkingHours = { days: number[]; start: string; end: string };

export type ActiveStatus = {
  emoji: string | null;
  text: string | null;
  expiresAt: Date | null;
};

type StatusFields = {
  statusEmoji?: string | null;
  statusText?: string | null;
  statusExpiresAt?: Date | string | null;
};

/** Up to two initials, grapheme-safe (Array.from splits by code point). */
export function getInitials(name: string, fallback = ""): string {
  const source = name.trim() || fallback.trim();
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
}

export const AVATAR_COLOR_COUNT = 8;

/** Stable 0..7 bucket per user id (FNV-1a), so a user keeps one colour. */
export function avatarColorIndex(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % AVATAR_COLOR_COUNT;
}

/**
 * The status to show, or null. Expiry is enforced on read, so no job has to
 * clear stale rows; the next setStatus overwrites them.
 */
export function activeStatus(
  u: StatusFields,
  now: Date = new Date()
): ActiveStatus | null {
  if (!u.statusEmoji && !u.statusText) return null;
  const expiresAt = u.statusExpiresAt ? new Date(u.statusExpiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return null;
  return {
    emoji: u.statusEmoji ?? null,
    text: u.statusText ?? null,
    expiresAt,
  };
}

const WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** ISO weekday (1 = Monday) and minutes since midnight in `timeZone`. */
export function zonedClock(
  timeZone: string,
  date: Date
): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAY[get("weekday")] ?? 1,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const toMinutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Start inclusive, end exclusive. Overnight ranges are rejected at input. */
export function isWithinWorkingHours(
  wh: WorkingHours,
  timeZone: string,
  now: Date
): boolean {
  const { weekday, minutes } = zonedClock(timeZone, now);
  return (
    wh.days.includes(weekday) &&
    minutes >= toMinutes(wh.start) &&
    minutes < toMinutes(wh.end)
  );
}

/** When working hours next begin, or null while inside them (or no days). */
export function nextWorkingStart(
  wh: WorkingHours,
  timeZone: string,
  now: Date
): { daysAhead: number; start: string } | null {
  if (wh.days.length === 0 || isWithinWorkingHours(wh, timeZone, now)) {
    return null;
  }
  const { weekday, minutes } = zonedClock(timeZone, now);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = ((weekday - 1 + ahead) % 7) + 1;
    if (!wh.days.includes(day)) continue;
    if (ahead === 0 && minutes >= toMinutes(wh.start)) continue;
    return { daysAhead: ahead, start: wh.start };
  }
  return null;
}

/**
 * Re-checks a status already serialised onto a card (ISO expiry) against the
 * clock at render time, so a card kept open past the expiry drops the status.
 */
export function liveCardStatus<
  S extends {
    emoji: string | null;
    text: string | null;
    expiresAt: string | null;
  },
>(status: S | null, now: Date = new Date()): S | null {
  if (!status) return null;
  const active = activeStatus(
    {
      statusEmoji: status.emoji,
      statusText: status.text,
      statusExpiresAt: status.expiresAt,
    },
    now
  );
  return active ? status : null;
}

export type StatusPreset = "30m" | "1h" | "4h" | "today" | "week" | "never";

// UTC instant of local midnight `daysAhead` days after `now`'s local date.
function localMidnight(now: Date, timeZone: string, daysAhead: number): Date {
  const { minutes } = zonedClock(timeZone, now);
  const offsetMs = (() => {
    const p =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(now)
        .find((x) => x.type === "timeZoneName")?.value ?? "GMT";
    const m = p.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
  })();
  const localNow = now.getTime() + offsetMs;
  const startOfLocalDay =
    localNow -
    (minutes * 60_000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
  return new Date(startOfLocalDay + daysAhead * 86_400_000 - offsetMs);
}

/**
 * When a status set `now` should expire for the given preset. The offset is
 * taken at `now`; a DST jump before midnight shifts the result by up to an
 * hour, which is acceptable for a status.
 */
export function expiryFromPreset(
  preset: StatusPreset,
  now: Date,
  timeZone: string
): Date | null {
  switch (preset) {
    case "30m":
      return new Date(now.getTime() + 30 * 60_000);
    case "1h":
      return new Date(now.getTime() + 60 * 60_000);
    case "4h":
      return new Date(now.getTime() + 4 * 60 * 60_000);
    case "today":
      return localMidnight(now, timeZone, 1);
    case "week": {
      const { weekday } = zonedClock(timeZone, now);
      return localMidnight(now, timeZone, 8 - weekday); // next Monday 00:00
    }
    case "never":
      return null;
  }
}

/** "keep" re-sends the current status's expiry instead of restarting it. */
export type StatusExpiryChoice = StatusPreset | "keep";

/**
 * Editing a status must not silently change when it clears: an existing
 * status starts on "keep" (or "never" when it had no expiry). A new status
 * starts on "today".
 */
export function initialStatusExpiry(
  current: { expiresAt: string | null } | null
): StatusExpiryChoice {
  if (!current) return "today";
  return current.expiresAt ? "keep" : "never";
}

/** ISO expiry to send for a choice; "keep" passes the current one through. */
export function resolveStatusExpiry(
  choice: StatusExpiryChoice,
  currentExpiresAt: string | null,
  now: Date,
  timeZone: string
): string | null {
  if (choice === "keep") return currentExpiresAt;
  return expiryFromPreset(choice, now, timeZone)?.toISOString() ?? null;
}
