# User Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-managed user identity: display name, avatar, title, bio, timezone, working hours and status. It is shown on `/people`, on `/people/[id]`, and in a hover card on every user name.

**Architecture:**
- New nullable columns on `users`, exposed through better-auth `additionalFields` with `input: false` and written only by our own server actions.
- Avatars live in Garage under `avatars/<userId>/<hash>` and are served through a session-gated route via imgproxy. The Microsoft 365 photo is imported after Microsoft sign-in.
- Shared `UserAvatar`/`UserName` components wrap a Base UI `PreviewCard` that lazily fetches `/api/users/[id]/card`.
- The reader's timezone feeds next-intl's `timeZone`.

**Tech Stack:** Next.js 16 (App Router, `after()`), React 19 (`use`), better-auth 1.7, drizzle-orm 1.0 rc (RQB v2), zod 4, next-intl 4, Base UI (`@base-ui/react/preview-card`), Tailwind 4, Garage S3, imgproxy, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-09-user-profiles-design.md`

## Global Constraints

- Runtime and tooling: Bun (`bun run typecheck`, `bun run lint`, `bun test`). Never `npm`/`npx`.
- **i18n.** Every new user-facing string goes into all five `messages/{ar,en,es,id,zh}.json` under the same key path. The `en` text is given in each task. Write natural translations for `ar`, `es`, `id` and `zh`. No string is hard-coded in components.
- **RTL.** Use logical Tailwind properties only (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/`text-start`). Never `ml-`/`mr-`/`left-`/`right-`/`text-left`.
- **No new npm dependencies.** Cropping, the emoji picker and the timezone list are built from the platform (`canvas`, `Intl`) and existing `components/ui/*`.
- **Server actions** live in `actions/*.ts` with `"use server"`. They validate with zod schemas from `lib/validation.ts`, return `ActionResponse` (`lib/types.ts`), take messages from `getTranslations("actionErrors")`, and call `recordActivity` and `revalidatePath`.
- **Route handlers** return 401 without a session (`getServerSession`). They never use server actions for reads.
- Field limits:
  - `name` 1–100
  - `title` ≤ 80
  - `bio` ≤ 280, plain text
  - `status_text` ≤ 80
  - `status_emoji`: one emoji grapheme, ≤ 32 UTF-8 bytes
  - avatar upload ≤ 5 MB, png/jpeg/webp/avif only (no SVG, no GIF)
- **Avatar sizes** snap up to `{24, 32, 40, 64, 96, 128, 256}`. The default is 64.
- **Timestamps** use plain `timestamp(...)`, matching the rest of `lib/db/schema.ts`.
- **Commits.** Conventional style (`feat(profile): …`). **Do not add any `Co-Authored-By` trailer.**
- **Project data** shown about another user is always filtered to the viewer's projects via `projectScope` / `projectIdsWhere` / `getProjectAccess` (`lib/authz.ts`).

## Review Focus

1. **Display-name collision on account creation.** A first Microsoft sign-in or an invite acceptance whose name already belongs to an active user must still succeed, with a disambiguated name. Pinned by `disambiguateName` tests in Task 3.
2. **A member opens the profile of someone who works in projects the member can't see.** No project names, issue keys or environment names may appear. Pinned by `authz-guards` entries in Task 9, plus manual check M3 in Task 13.
3. **A status that expires while the card or page is already open.** It must disappear on the next render, not linger. `activeStatus` treats `expiresAt == now` as expired. Pinned in Task 1.
4. **Odd timezone strings.** An offset string (`+07:00`) is rejected. A legacy alias (`Asia/Calcutta`) is accepted. A bad value already stored in the DB never crashes rendering, because `effectiveTimeZone` falls back to `APP_TIMEZONE`. Pinned in Task 2.
5. **Stale avatar URLs.** An avatar URL whose object was replaced returns 404, and the component falls back to initials. A GIF or SVG renamed `.png` is rejected by the sniff. Pinned in Tasks 5 and 7.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/user-display.ts` | create | Pure helpers: initials, avatar colour index, active status, working-hours math |
| `lib/timezone.ts` | modify | `isValidTimeZone`, `effectiveTimeZone` |
| `lib/validation.ts` | modify | Profile, status and timezone zod schemas |
| `lib/db/schema.ts` | modify | New `users` columns and partial unique index |
| `drizzle/20261009000000_user_profile/migration.sql` | create | Migration |
| `lib/auth.ts` | modify | `user.additionalFields`, unique-name fix in the create hook, Microsoft avatar `hooks.after` |
| `lib/people/names.ts` | create | `disambiguateName` (pure) and `pickFreeName` (DB) |
| `lib/reserved-paths.ts` | modify | Reserve `PEOPLE` |
| `actions/profile.ts` | create | `updateProfile`, `setStatus`, `clearStatus`, `adminUpdateProfile` |
| `lib/image-sniff.ts` | create | `sniffImage`, moved out of the KB upload route |
| `lib/imgproxy.ts` | modify | `fill` resize option |
| `lib/avatar-url.ts` | create | Pure: sizes, snapping, `avatarSrc`, key/hash parsing |
| `lib/avatars.ts` | create | Server: `storeAvatar`, `removeAvatar` |
| `lib/avatars-microsoft.ts` | create | `importMicrosoftAvatar` |
| `app/api/avatars/route.ts` | create | `POST` upload, `DELETE` remove |
| `app/api/avatars/microsoft/route.ts` | create | `POST` forced Microsoft import |
| `app/api/avatars/[userId]/[hash]/route.ts` | create | `GET` serve via imgproxy |
| `lib/people/card.ts` | create | `getUserCard(id)` server query and `UserCardData` type |
| `app/api/users/[id]/card/route.ts` | create | `GET` card JSON |
| `components/ui/preview-card.tsx` | create | shadcn-style Base UI PreviewCard wrapper |
| `components/user/user-avatar.tsx` | create | Avatar or initials |
| `components/user/user-name.tsx` | create | Hover-card trigger link |
| `components/user/user-card.tsx` | create | Card body (client, Suspense) |
| `components/user/user-card-cache.ts` | create | Client promise cache |
| `components/user/local-time.tsx` | create | Ticking local time and working-hours state |
| `components/user/status-popover.tsx` | create | Set/clear status UI |
| `components/user/avatar-cropper.tsx` | create | Crop dialog |
| `components/user/timezone-hint.tsx` | create | One-time "use browser zone?" banner |
| `app/[locale]/account/profile-form.tsx` | create | Editable profile tab, replacing `profile-card.tsx` |
| `lib/people/queries.ts` | create | Directory and profile reads (viewer-scoped) |
| `app/[locale]/people/page.tsx`, `people-client.tsx` | create | Directory |
| `app/[locale]/people/[id]/page.tsx` | create | Profile page |
| `components/user-menu.tsx`, `components/app-sidebar.tsx`, `components/command-palette.tsx` | modify | Entry points |
| `i18n/request.ts`, `app/[locale]/layout.tsx`, `app/[locale]/(home)/page.tsx` | modify | Per-user timezone |
| `lib/issue-query.ts`, `app/[locale]/issues/page.tsx` | modify | `assignee` filter |
| ~15 call sites (Tasks 11–12) | modify | Use `UserName`/`UserAvatar` |

---

### Task 1: Pure display helpers

**Files:**
- Create: `lib/user-display.ts`
- Test: `tests/user-display.test.ts`

**Interfaces:**
- Produces:
  - `type WorkingHours = { days: number[]; start: string; end: string }`
  - `type ActiveStatus = { emoji: string | null; text: string | null; expiresAt: Date | null }`
  - `getInitials(name: string, fallback?: string): string`
  - `AVATAR_COLOR_COUNT = 8`
  - `avatarColorIndex(id: string): number`
  - `activeStatus(u: StatusFields, now?: Date): ActiveStatus | null`, where `StatusFields = { statusEmoji: string | null; statusText: string | null; statusExpiresAt: Date | string | null }`
  - `zonedClock(timeZone: string, date: Date): { weekday: number; minutes: number }`
  - `isWithinWorkingHours(wh: WorkingHours, timeZone: string, now: Date): boolean`
  - `nextWorkingStart(wh: WorkingHours, timeZone: string, now: Date): { daysAhead: number; start: string } | null`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/user-display.test.ts
import { describe, expect, it } from "bun:test";
import {
  AVATAR_COLOR_COUNT,
  activeStatus,
  avatarColorIndex,
  getInitials,
  isWithinWorkingHours,
  nextWorkingStart,
  zonedClock,
} from "@/lib/user-display";

describe("getInitials", () => {
  it.each([
    ["Romi Kusuma Bakti", "RK"],
    ["budi", "B"],
    ["  ana   maria ", "AM"],
    ["Élodie Ørsted", "ÉØ"],
    ["𝒜lpha Beta", "𝒜B"],
  ])("%s -> %s", (name, expected) => {
    expect(getInitials(name)).toBe(expected);
  });

  it("falls back to the fallback (email) when the name is blank", () => {
    expect(getInitials("   ", "dev@x.id")).toBe("D");
  });

  it("returns an empty string when both are blank", () => {
    expect(getInitials("", "")).toBe("");
  });
});

describe("avatarColorIndex", () => {
  it("is deterministic and in range", () => {
    const id = "0199a1b2-0000-7000-8000-000000000001";
    expect(avatarColorIndex(id)).toBe(avatarColorIndex(id));
    expect(avatarColorIndex(id)).toBeGreaterThanOrEqual(0);
    expect(avatarColorIndex(id)).toBeLessThan(AVATAR_COLOR_COUNT);
  });

  it("spreads ids over more than one colour", () => {
    const seen = new Set(
      Array.from({ length: 50 }, (_, i) => avatarColorIndex(`user-${i}`))
    );
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe("activeStatus", () => {
  const now = new Date("2026-10-09T10:00:00Z");
  const base = { statusEmoji: "🌴", statusText: "Leave", statusExpiresAt: null };

  it("returns null when nothing is set", () => {
    expect(
      activeStatus({ statusEmoji: null, statusText: null, statusExpiresAt: null }, now)
    ).toBeNull();
  });

  it("returns the status with no expiry", () => {
    expect(activeStatus(base, now)).toEqual({
      emoji: "🌴",
      text: "Leave",
      expiresAt: null,
    });
  });

  it("keeps a status that expires in the future (string or Date)", () => {
    expect(
      activeStatus({ ...base, statusExpiresAt: "2026-10-09T10:00:01Z" }, now)
    ).not.toBeNull();
  });

  it("drops a status at exactly its expiry", () => {
    expect(
      activeStatus({ ...base, statusExpiresAt: new Date(now) }, now)
    ).toBeNull();
  });
});

describe("working hours", () => {
  const wh = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  // 2026-10-09 is a Friday.
  it("reads the wall clock in the given zone", () => {
    expect(zonedClock("Asia/Jakarta", new Date("2026-10-09T02:30:00Z"))).toEqual({
      weekday: 5,
      minutes: 9 * 60 + 30,
    });
    // Same instant is still Thursday evening in New York.
    expect(zonedClock("America/New_York", new Date("2026-10-09T02:30:00Z")).weekday).toBe(4);
  });

  it("is inside at start, outside at end", () => {
    expect(isWithinWorkingHours(wh, "Asia/Jakarta", new Date("2026-10-09T02:00:00Z"))).toBe(true); // 09:00 WIB
    expect(isWithinWorkingHours(wh, "Asia/Jakarta", new Date("2026-10-09T10:00:00Z"))).toBe(false); // 17:00 WIB
  });

  it("is outside on a non-working day", () => {
    expect(isWithinWorkingHours(wh, "Asia/Jakarta", new Date("2026-10-10T03:00:00Z"))).toBe(false); // Sat 10:00
  });

  it("next start: later today, tomorrow, after the weekend, none while inside", () => {
    expect(nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-09T00:00:00Z"))).toEqual({ daysAhead: 0, start: "09:00" }); // Fri 07:00
    expect(nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-08T12:00:00Z"))).toEqual({ daysAhead: 1, start: "09:00" }); // Thu 19:00
    expect(nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-09T12:00:00Z"))).toEqual({ daysAhead: 3, start: "09:00" }); // Fri 19:00 -> Mon
    expect(nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-09T03:00:00Z"))).toBeNull();
  });

  it("wraps a full week when the only working day has passed", () => {
    const fridays = { days: [5], start: "09:00", end: "10:00" };
    expect(nextWorkingStart(fridays, "UTC", new Date("2026-10-09T11:00:00Z"))).toEqual({ daysAhead: 7, start: "09:00" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/user-display.test.ts`
Expected: FAIL with `Cannot find module '@/lib/user-display'`.

- [ ] **Step 3: Implement**

```ts
// lib/user-display.ts
// Pure helpers for rendering a user's identity. No server-only imports: the
// avatar, card and directory components use these on the client too.

export type WorkingHours = { days: number[]; start: string; end: string };

export type ActiveStatus = {
  emoji: string | null;
  text: string | null;
  expiresAt: Date | null;
};

type StatusFields = {
  statusEmoji: string | null;
  statusText: string | null;
  statusExpiresAt: Date | string | null;
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
  return { emoji: u.statusEmoji, text: u.statusText, expiresAt };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/user-display.test.ts`
Expected: all PASS.

- [ ] **Step 5: Replace the duplicated initials helpers**

In each of `components/user-menu.tsx` (the inline `initials` computation), `app/[locale]/account/profile-card.tsx` (`getInitials`) and `app/[locale]/admin/users/users-client.tsx` (`getInitials`, around line 83):
- delete the local helper
- import `getInitials` from `@/lib/user-display`
- call `getInitials(user.name, user.email)`

`profile-card.tsx` is removed in Task 8, but keep it compiling until then.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/user-display.ts tests/user-display.test.ts components/user-menu.tsx app/[locale]/account/profile-card.tsx app/[locale]/admin/users/users-client.tsx
git commit -m "feat(profile): pure helpers for initials, status and working hours"
```

---

### Task 2: Timezone and profile validation

**Files:**
- Modify: `lib/timezone.ts`, `lib/env.ts:76-84`, `lib/validation.ts` (append)
- Test: `tests/profile-validation.test.ts`

**Interfaces:**
- Consumes: `WorkingHours` from Task 1.
- Produces:
  - `isValidTimeZone(v: string): boolean`
  - `effectiveTimeZone(user: { timezone?: string | null } | null | undefined): string`
  - `timeZoneSchema`
  - `workingHoursSchema`
  - `statusEmojiSchema`
  - `profileInputSchema`, with type `ProfileInput = { name: string; title: string | null; bio: string | null; timezone: string | null; workingHours: WorkingHours | null }`
  - `statusInputSchema`, with type `StatusInput = { emoji: string | null; text: string | null; expiresAt: string | null }`
  - `PROFILE_LIMITS = { name: 100, title: 80, bio: 280, statusText: 80 }`
  - `AVATAR_MAX_BYTES = 5 * 1024 * 1024`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/profile-validation.test.ts
import { describe, expect, it } from "bun:test";
import { effectiveTimeZone, isValidTimeZone, APP_TIMEZONE } from "@/lib/timezone";
import {
  profileInputSchema,
  statusEmojiSchema,
  statusInputSchema,
  timeZoneSchema,
  workingHoursSchema,
} from "@/lib/validation";

describe("timeZoneSchema", () => {
  it.each(["Asia/Jakarta", "Asia/Makassar", "UTC", "Asia/Calcutta", "Etc/GMT+7", "America/Argentina/Buenos_Aires"])(
    "accepts %s",
    (tz) => expect(timeZoneSchema.safeParse(tz).success).toBe(true)
  );
  it.each(["", "+07:00", "Mars/Olympus", "asia jakarta", "GMT+7:00"])(
    "rejects %s",
    (tz) => expect(timeZoneSchema.safeParse(tz).success).toBe(false)
  );
});

describe("effectiveTimeZone", () => {
  it("uses the user's zone when valid", () => {
    expect(effectiveTimeZone({ timezone: "Asia/Makassar" })).toBe("Asia/Makassar");
  });
  it.each([null, undefined, { timezone: null }, { timezone: "Not/AZone" }])(
    "falls back to APP_TIMEZONE for %p",
    (u) => expect(effectiveTimeZone(u)).toBe(APP_TIMEZONE)
  );
  it("isValidTimeZone rejects offsets", () => {
    expect(isValidTimeZone("+07:00")).toBe(false);
  });
});

describe("workingHoursSchema", () => {
  const ok = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  it("accepts a normal week", () => {
    expect(workingHoursSchema.safeParse(ok).success).toBe(true);
  });
  it.each([
    ["no days", { ...ok, days: [] }],
    ["duplicate days", { ...ok, days: [1, 1] }],
    ["day 0", { ...ok, days: [0] }],
    ["day 8", { ...ok, days: [8] }],
    ["start == end", { ...ok, end: "09:00" }],
    ["overnight", { ...ok, start: "22:00", end: "06:00" }],
    ["bad time", { ...ok, start: "9:00" }],
    ["24:00", { ...ok, end: "24:00" }],
  ])("rejects %s", (_label, value) => {
    expect(workingHoursSchema.safeParse(value).success).toBe(false);
  });
});

describe("statusEmojiSchema", () => {
  it.each(["🌴", "🎯", "🇮🇩", "👨‍👩‍👧‍👦", "🧑🏽‍💻", "☕"])("accepts %s", (e) =>
    expect(statusEmojiSchema.safeParse(e).success).toBe(true)
  );
  it.each(["", "a", "🌴🌴", ":)", "🌴 "])("rejects %p", (e) =>
    expect(statusEmojiSchema.safeParse(e).success).toBe(false)
  );
});

describe("profileInputSchema", () => {
  const base = { name: "Budi", title: "", bio: "", timezone: null, workingHours: null };
  it("trims and turns blanks into null", () => {
    const r = profileInputSchema.parse({ ...base, name: "  Budi  ", title: "  " });
    expect(r).toEqual({ name: "Budi", title: null, bio: null, timezone: null, workingHours: null });
  });
  it("rejects an empty name", () => {
    expect(profileInputSchema.safeParse({ ...base, name: "  " }).success).toBe(false);
  });
  it("enforces limits", () => {
    expect(profileInputSchema.safeParse({ ...base, title: "x".repeat(81) }).success).toBe(false);
    expect(profileInputSchema.safeParse({ ...base, bio: "x".repeat(281) }).success).toBe(false);
    expect(profileInputSchema.safeParse({ ...base, bio: "x".repeat(280) }).success).toBe(true);
  });
});

describe("statusInputSchema", () => {
  it("needs an emoji or text", () => {
    expect(statusInputSchema.safeParse({ emoji: null, text: "", expiresAt: null }).success).toBe(false);
    expect(statusInputSchema.safeParse({ emoji: "🌴", text: "", expiresAt: null }).success).toBe(true);
  });
  it("requires an ISO instant with offset", () => {
    expect(statusInputSchema.safeParse({ emoji: "🌴", text: null, expiresAt: "2026-10-10" }).success).toBe(false);
    expect(statusInputSchema.safeParse({ emoji: "🌴", text: null, expiresAt: "2026-10-10T00:00:00Z" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/profile-validation.test.ts`
Expected: FAIL (`isValidTimeZone` / `timeZoneSchema` not exported).

- [ ] **Step 3: Implement `lib/timezone.ts`**

```ts
// lib/timezone.ts
export const APP_TIMEZONE = process.env.APP_TIMEZONE ?? "Asia/Jakarta";

// IANA names only. Recent engines also accept UTC offsets ("+07:00") as a
// timeZone, which have no DST rules and no name to show, so they are refused.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isValidTimeZone(value: string): boolean {
  if (!IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The zone a user reads dates in: their own if set and valid, else the app's. */
export function effectiveTimeZone(
  user: { timezone?: string | null } | null | undefined
): string {
  const tz = user?.timezone;
  return tz && isValidTimeZone(tz) ? tz : APP_TIMEZONE;
}
```

In `lib/env.ts`, replace the body of `timezoneSchema` (lines 76-84) with:

```ts
const timezoneSchema = z
  .string()
  .refine(isValidTimeZone, "must be a valid IANA timezone name (e.g. Asia/Jakarta)");
```

and add `import { isValidTimeZone } from "@/lib/timezone";`, matching the file's existing import style. Run `bun test tests/env.test.ts` to confirm nothing regressed.

- [ ] **Step 4: Append the schemas to `lib/validation.ts`**

```ts
// --- User profiles ---

import { isValidTimeZone } from "@/lib/timezone";
import type { WorkingHours } from "@/lib/user-display";

export const PROFILE_LIMITS = { name: 100, title: 80, bio: 280, statusText: 80 } as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export const timeZoneSchema = z.string().refine(isValidTimeZone, "Unknown timezone");

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const workingHoursSchema = z
  .object({
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, "Duplicate day"),
    start: hhmm,
    end: hhmm,
  })
  // HH:MM strings compare correctly as text. Overnight shifts are out of scope.
  .refine((w) => w.start < w.end, "End must be after start") satisfies z.ZodType<WorkingHours>;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export const statusEmojiSchema = z
  .string()
  .refine(
    (v) =>
      [...graphemes.segment(v)].length === 1 &&
      new TextEncoder().encode(v).length <= 32 &&
      /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(v),
    "Pick a single emoji"
  );

// Trimmed optional text: "" and whitespace become null so the column stays clean.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .transform((v) => v ?? null);

export const profileInputSchema = z.object({
  name: z.string().trim().min(1).max(PROFILE_LIMITS.name),
  title: optionalText(PROFILE_LIMITS.title),
  bio: optionalText(PROFILE_LIMITS.bio),
  timezone: timeZoneSchema.nullable(),
  workingHours: workingHoursSchema.nullable(),
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

export const statusInputSchema = z
  .object({
    emoji: statusEmojiSchema.nullable(),
    text: optionalText(PROFILE_LIMITS.statusText),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .refine((s) => s.emoji !== null || s.text !== null, "Status is empty");
export type StatusInput = z.infer<typeof statusInputSchema>;
```

Move the two `import` lines to the top of `lib/validation.ts`, next to the existing imports. Biome's import ordering will complain otherwise.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/profile-validation.test.ts tests/validation.test.ts tests/env.test.ts`
Expected: all PASS.

If `"Etc/GMT+7"` fails the regex, `+` is already allowed in segments. Check that the test string has no stray whitespace.

- [ ] **Step 6: Commit**

```bash
git add lib/timezone.ts lib/env.ts lib/validation.ts tests/profile-validation.test.ts
git commit -m "feat(profile): timezone, working-hours and status validation"
```

---

### Task 3: Schema, migration, better-auth fields, unique names, reserved path

**Files:**
- Modify: `lib/db/schema.ts:638-654`, `lib/auth.ts`, `lib/reserved-paths.ts`
- Create: `lib/people/names.ts`, `drizzle/20261009000000_user_profile/migration.sql`
- Test: `tests/people-names.test.ts`, `tests/validation.test.ts` (add one case)

**Interfaces:**
- Consumes: `WorkingHours` (Task 1).
- Produces:
  - `users` columns: `title`, `bio`, `timezone`, `workingHours`, `statusEmoji`, `statusText`, `statusExpiresAt`, `avatarSource`
  - `type AvatarSource = "upload" | "microsoft" | "removed"`, exported from `lib/db/schema.ts`
  - `disambiguateName(name: string, email: string, attempt: number): string`
  - `pickFreeName(name: string, email: string): Promise<string>`
  - `isUniqueViolation(e: unknown): boolean`
  - `Session["user"]` carries all new fields

- [ ] **Step 1: Write the failing tests**

```ts
// tests/people-names.test.ts
import { describe, expect, it } from "bun:test";
import { disambiguateName, isUniqueViolation } from "@/lib/people/names";

describe("disambiguateName", () => {
  it("keeps the name on attempt 0", () => {
    expect(disambiguateName("Budi Santoso", "budi.s@dss.id", 0)).toBe("Budi Santoso");
  });
  it("adds the email local part on attempt 1", () => {
    expect(disambiguateName("Budi Santoso", "budi.s@dss.id", 1)).toBe("Budi Santoso (budi.s)");
  });
  it("adds a counter after that", () => {
    expect(disambiguateName("Budi Santoso", "budi.s@dss.id", 3)).toBe("Budi Santoso (budi.s) 3");
  });
  it("never exceeds 100 characters", () => {
    expect(disambiguateName("x".repeat(100), "someone@dss.id", 2).length).toBeLessThanOrEqual(100);
  });
});

describe("isUniqueViolation", () => {
  it("matches postgres 23505, directly or wrapped in cause", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});
```

In `tests/validation.test.ts`, inside `describe("projectKeySchema")`, add:

```ts
it("reserves PEOPLE", () => {
  expect(projectKeySchema.safeParse("PEOPLE").success).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/people-names.test.ts tests/validation.test.ts`
Expected: FAIL (module missing; `PEOPLE` accepted).

- [ ] **Step 3: Implement `lib/people/names.ts`**

```ts
// lib/people/names.ts
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Display names are unique among active users (case-insensitive), because
// mentions resolve by exact @name. Account creation must never fail on a
// clash, so creation paths pick the first free variant.
const MAX = 100;

export function disambiguateName(name: string, email: string, attempt: number): string {
  if (attempt === 0) return name.slice(0, MAX);
  const local = email.split("@")[0] ?? "";
  const suffix = attempt === 1 ? ` (${local})` : ` (${local}) ${attempt}`;
  return name.slice(0, MAX - suffix.length) + suffix;
}

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
}

async function nameTaken(name: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.banned, false), sql`lower(${users.name}) = lower(${name})`))
    .limit(1);
  return Boolean(row);
}

export async function pickFreeName(name: string, email: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = disambiguateName(name.trim(), email, attempt);
    if (!(await nameTaken(candidate))) return candidate;
  }
  // 50 identical names is not a real directory; let the unique index decide.
  return disambiguateName(name.trim(), email, 50);
}
```

- [ ] **Step 4: Extend the `users` table in `lib/db/schema.ts`**

Add the type export above `users`, and the columns plus the index:

```ts
export type AvatarSource = "upload" | "microsoft" | "removed";

export const users = pgTable(
  "users",
  {
    // ...existing columns unchanged...
    jiraAccountId: text("jira_account_id"),
    // --- Profile (self-managed; see actions/profile.ts) ---
    title: text("title"),
    bio: text("bio"),
    // IANA zone; null = APP_TIMEZONE (lib/timezone effectiveTimeZone).
    timezone: text("timezone"),
    workingHours: jsonb("working_hours").$type<WorkingHours>(),
    // Status expiry is enforced on read (lib/user-display activeStatus).
    statusEmoji: text("status_emoji"),
    statusText: text("status_text"),
    statusExpiresAt: timestamp("status_expires_at"),
    // Where `image` came from. 'removed' blocks the Microsoft re-import.
    avatarSource: text("avatar_source").$type<AvatarSource>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Mentions resolve by exact @name, so active names must not collide.
    uniqueIndex("users_active_name_lower_idx")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.banned} = false`),
  ]
);
```

Import `type WorkingHours` from `@/lib/user-display`. `jsonb`, `uniqueIndex` and `sql` are already imported in this file; confirm with grep.

- [ ] **Step 5: Write the migration by hand**

This keeps the repo's folder naming. Create `drizzle/20261009000000_user_profile/migration.sql`:

```sql
-- User profiles: self-managed identity fields, status and avatar provenance.
-- All columns nullable, no backfill.
--
-- Pre-flight (run first; both must return zero rows):
--   SELECT lower(name), count(*) FROM users WHERE NOT banned
--     GROUP BY 1 HAVING count(*) > 1;
--   SELECT id FROM projects WHERE key = 'PEOPLE';
ALTER TABLE "users" ADD COLUMN "title" text;
ALTER TABLE "users" ADD COLUMN "bio" text;
ALTER TABLE "users" ADD COLUMN "timezone" text;
ALTER TABLE "users" ADD COLUMN "working_hours" jsonb;
ALTER TABLE "users" ADD COLUMN "status_emoji" text;
ALTER TABLE "users" ADD COLUMN "status_text" text;
ALTER TABLE "users" ADD COLUMN "status_expires_at" timestamp;
ALTER TABLE "users" ADD COLUMN "avatar_source" text;
CREATE UNIQUE INDEX "users_active_name_lower_idx" ON "users" (lower("name")) WHERE "banned" = false;
```

Copy the `snapshot.json` produced by `bunx drizzle-kit generate --name user_profile` into the folder, so later generates diff correctly. Run the generate command, compare its SQL with the file above (they must be equivalent), keep the hand-written comment header, and delete any duplicate folder it created.

Run: `bunx drizzle-kit generate` again.
Expected: "No schema changes".

- [ ] **Step 6: Wire better-auth in `lib/auth.ts`**

Add a `user` block next to `account`:

```ts
  user: {
    // Profile fields ride on the session (the layout needs timezone and
    // status on every render) but are written only by actions/profile.ts,
    // never through /update-user, hence input: false.
    additionalFields: {
      title: { type: "string", required: false, input: false },
      bio: { type: "string", required: false, input: false },
      timezone: { type: "string", required: false, input: false },
      workingHours: { type: "json", required: false, input: false },
      statusEmoji: { type: "string", required: false, input: false },
      statusText: { type: "string", required: false, input: false },
      statusExpiresAt: { type: "date", required: false, input: false },
      avatarSource: { type: "string", required: false, input: false },
    },
  },
```

Extend `databaseHooks.user.create.before` so it returns a de-duplicated name after the domain check:

```ts
        before: async (user) => {
          if (!isAllowedEmail(user.email)) {
            throw APIError.from("FORBIDDEN", { message: "domain not allowed", code: "domain_not_allowed" });
          }
          // A clashing display name must never block a sign-in or an invite.
          return { data: { ...user, name: await pickFreeName(user.name, user.email) } };
        },
```

Import `pickFreeName` from `@/lib/people/names`.

- [ ] **Step 7: Reserve `PEOPLE`**

In `lib/reserved-paths.ts` add `"PEOPLE",` between `"KNOWLEDGE"` and `"PROJECT"`.

- [ ] **Step 8: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: all PASS. `Session["user"]` now has `timezone?: string | null` etc. Verify by hovering, or with a scratch `const _t: string | null | undefined = ({} as Session["user"]).timezone;`, then delete the scratch line.

- [ ] **Step 9: Apply locally and commit**

Run: `bun run db:migrate` against the local DB.
Expected: migration applied.

```bash
git add lib/db/schema.ts drizzle/20261009000000_user_profile lib/auth.ts lib/people/names.ts lib/reserved-paths.ts tests/people-names.test.ts tests/validation.test.ts
git commit -m "feat(profile): user profile columns, session fields and unique display names"
```

---

### Task 4: Profile and status server actions

**Files:**
- Create: `actions/profile.ts`
- Modify: `actions/users.ts` (`updateUserName`, lines 272-296), `app/[locale]/admin/users/users-client.tsx` (caller), `messages/*.json` (`actionErrors`)
- Test: `tests/authz-guards.test.ts` (no project scope here; add nothing). Validation is covered by Task 2. This task is verified with typecheck and in the UI tasks.

**Interfaces:**
- Consumes:
  - `profileInputSchema`, `statusInputSchema` (Task 2)
  - `isUniqueViolation` (Task 3)
- Produces:
  - `updateProfile(input: unknown): Promise<ActionResponse>`
  - `setStatus(input: unknown): Promise<ActionResponse>`
  - `clearStatus(): Promise<ActionResponse>`
  - `adminUpdateProfile(input: { userId: string; name: string; title: string | null }): Promise<ActionResponse>`, which replaces `updateUserName`

- [ ] **Step 1: Add the i18n keys**

Add to `actionErrors` in all 5 locales:
- `nameTaken`: "That name is already used by someone else."
- `statusExpired`: "Pick an expiry in the future."
- `profileUpdated`: "Profile updated."
- `statusUpdated`: "Status updated."
- `statusCleared`: "Status cleared."

Remove `account.profile.nameManagedByAdmin` from all 5 locales in Task 8, not here.

- [ ] **Step 2: Implement `actions/profile.ts`**

```ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/people/names";
import type { ActionResponse } from "@/lib/types";
import {
  PROFILE_LIMITS,
  profileInputSchema,
  statusInputSchema,
  uuidSchema,
} from "@/lib/validation";

// Self-service profile edits. Every action here edits only the caller,
// except adminUpdateProfile, which needs user:update.

export async function updateProfile(input: unknown): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  try {
    await db
      .update(users)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));
  } catch (error) {
    if (isUniqueViolation(error)) return { success: false, message: t("nameTaken") };
    throw error;
  }

  await recordActivity({
    actorId: session.user.id,
    action: "profile.updated",
    entityType: "user",
    entityId: session.user.id,
    data: { user: parsed.data.name },
  });
  // Name, timezone and avatar appear in the shell on every page.
  revalidatePath("/", "layout");
  return { success: true, message: t("profileUpdated") };
}

export async function setStatus(input: unknown): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  const parsed = statusInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: t("invalidInput") };
  const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return { success: false, message: t("statusExpired") };
  }

  await db
    .update(users)
    .set({
      statusEmoji: parsed.data.emoji,
      statusText: parsed.data.text,
      statusExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(users.id, session.user.id));
  revalidatePath("/", "layout");
  return { success: true, message: t("statusUpdated") };
}

export async function clearStatus(): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  await db
    .update(users)
    .set({ statusEmoji: null, statusText: null, statusExpiresAt: null, updatedAt: new Date() })
    .where(eq(users.id, session.user.id));
  revalidatePath("/", "layout");
  return { success: true, message: t("statusCleared") };
}

export async function adminUpdateProfile(input: {
  userId: string;
  name: string;
  title: string | null;
}): Promise<ActionResponse> {
  const session = await requireOrgPermission({ user: ["update"] });
  const t = await getTranslations("actionErrors");
  if (!uuidSchema.safeParse(input.userId).success) {
    return { success: false, message: t("invalidInput") };
  }
  const name = input.name.trim();
  const title = input.title?.trim() || null;
  if (!name) return { success: false, message: t("nameRequired") };
  if (name.length > PROFILE_LIMITS.name) return { success: false, message: t("nameTooLong") };
  if (title && title.length > PROFILE_LIMITS.title) return { success: false, message: t("invalidInput") };

  let result: { id: string }[];
  try {
    result = await db
      .update(users)
      .set({ name, title, updatedAt: new Date() })
      .where(eq(users.id, input.userId))
      .returning({ id: users.id });
  } catch (error) {
    if (isUniqueViolation(error)) return { success: false, message: t("nameTaken") };
    throw error;
  }
  if (result.length === 0) return { success: false, message: t("errorGeneric") };

  await recordActivity({
    actorId: session.user.id,
    action: "profile.updated",
    entityType: "user",
    entityId: input.userId,
    data: { user: name },
  });
  revalidatePath("/admin/users");
  revalidatePath(`/people/${input.userId}`);
  return { success: true, message: t("nameUpdated") };
}
```

- [ ] **Step 3: Replace `updateUserName`**

Delete `updateUserName` from `actions/users.ts`. In `app/[locale]/admin/users/users-client.tsx`, import `adminUpdateProfile` from `@/actions/profile` and change the rename call to `adminUpdateProfile({ userId, name, title: user.title ?? null })`. Also add `title: userTable.title` to the `listUsers` select so the current title is preserved.

Search for other callers with `grep -rn updateUserName app components actions`. Every hit must be migrated.

- [ ] **Step 4: Render the activity entry**

In `app/[locale]/admin/activity/page.tsx` `message()`, add:

```ts
    case "profile.updated":
      return t("profileUpdated", { actor, user: String(d.user) });
```

and add `activity.profileUpdated`: "{actor} updated the profile of {user}" to all 5 locales.

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add actions/profile.ts actions/users.ts app/[locale]/admin messages
git commit -m "feat(profile): self-service profile and status actions"
```

---

### Task 5: Avatar storage core

**Files:**
- Create: `lib/image-sniff.ts`, `lib/avatar-url.ts`, `lib/avatars.ts`
- Modify: `app/api/knowledge/asset/route.ts` (use the shared sniff), `lib/imgproxy.ts`
- Test: `tests/avatar.test.ts`

**Interfaces:**
- Produces:
  - `sniffImage(buf: Buffer): { ext: string; mime: string } | null`
  - `AVATAR_SIZES`
  - `snapAvatarSize(raw: string | number | null | undefined): number`
  - `avatarSrc(image: string, px: number): string`
  - `avatarKey(userId: string, hash: string): string`
  - `avatarUrl(userId: string, hash: string): string`
  - `hashFromAvatarUrl(image: string | null | undefined): string | null`
  - `AVATAR_HASH_RE`
  - `imgproxyUrl(key, { width?, height?, quality?, fill? })`
  - `storeAvatar(userId: string, bytes: Buffer, source: "upload" | "microsoft"): Promise<{ ok: true; image: string } | { ok: false; error: "unsupported_type" }>`
  - `removeAvatar(userId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/avatar.test.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
  AVATAR_SIZES,
  avatarKey,
  avatarSrc,
  avatarUrl,
  hashFromAvatarUrl,
  snapAvatarSize,
} from "@/lib/avatar-url";
import { sniffImage } from "@/lib/image-sniff";

const UID = "0199a1b2-0000-7000-8000-000000000001";

describe("snapAvatarSize", () => {
  it.each([
    [null, 64], ["", 64], ["abc", 64], ["-5", 64],
    ["1", 24], ["24", 24], ["25", 32], ["64", 64], ["65", 96], ["9999", 256],
    [80, 96],
  ])("%p -> %p", (raw, expected) => {
    expect(snapAvatarSize(raw as string | number | null)).toBe(expected);
  });
  it("only yields allowed sizes", () => {
    for (let i = 0; i < 600; i += 7) expect(AVATAR_SIZES).toContain(snapAvatarSize(i));
  });
});

describe("avatar urls", () => {
  it("round-trips the hash", () => {
    const url = avatarUrl(UID, "0123456789abcdef");
    expect(url).toBe(`/api/avatars/${UID}/0123456789abcdef`);
    expect(hashFromAvatarUrl(url)).toBe("0123456789abcdef");
    expect(avatarKey(UID, "0123456789abcdef")).toBe(`avatars/${UID}/0123456789abcdef`);
  });
  it("ignores foreign urls", () => {
    expect(hashFromAvatarUrl("https://graph.microsoft.com/x")).toBeNull();
    expect(hashFromAvatarUrl(null)).toBeNull();
  });
  it("builds a sized src", () => {
    expect(avatarSrc(avatarUrl(UID, "0123456789abcdef"), 30)).toBe(`/api/avatars/${UID}/0123456789abcdef?s=32`);
  });
});

describe("sniffImage", () => {
  const pad = (b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);
  it("detects png/jpeg/webp/avif/gif", () => {
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47]))?.mime).toBe("image/png");
    expect(sniffImage(pad([0xff, 0xd8, 0xff]))?.mime).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))?.mime).toBe("image/webp");
    expect(sniffImage(Buffer.from("\0\0\0\x1cftypavif\0\0\0\0", "latin1"))?.mime).toBe("image/avif");
    expect(sniffImage(Buffer.from("GIF89a\0\0\0\0\0\0", "latin1"))?.mime).toBe("image/gif");
  });
  it("rejects svg and short buffers", () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe("imgproxyUrl fill", () => {
  beforeAll(() => {
    process.env.IMGPROXY_URL = "http://imgproxy:8080";
    process.env.IMGPROXY_KEY = "aa".repeat(32);
    process.env.IMGPROXY_SALT = "bb".repeat(32);
    process.env.S3_BUCKET = "knowledge";
  });
  it("signs an rs:fill path", async () => {
    const { imgproxyUrl } = await import("@/lib/imgproxy");
    const url = imgproxyUrl(`avatars/${UID}/0123456789abcdef`, { width: 64, fill: true });
    const [, signature, ...rest] = new URL(url).pathname.split("/");
    const path = `/${rest.join("/")}`;
    expect(path.startsWith("/rs:fill:64:64:1/g:ce/q:82/")).toBe(true);
    const expected = createHmac("sha256", Buffer.from(process.env.IMGPROXY_KEY!, "hex"))
      .update(Buffer.from(process.env.IMGPROXY_SALT!, "hex"))
      .update(path)
      .digest("base64url");
    expect(signature).toBe(expected);
  });
  it("keeps the fit default", async () => {
    const { imgproxyUrl } = await import("@/lib/imgproxy");
    expect(imgproxyUrl("kb/x.png")).toContain("/rs:fit:1600:0/q:82/");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/avatar.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Extract `sniffImage` into `lib/image-sniff.ts`**

Move the function from `app/api/knowledge/asset/route.ts` unchanged, including its comment, and export it. In the route, delete it and `import { sniffImage } from "@/lib/image-sniff";`.

- [ ] **Step 4: Write `lib/avatar-url.ts`**

```ts
// Pure avatar URL helpers, shared by the server routes and <UserAvatar>.
// The URL carries a content hash, so a changed picture is a new URL and the
// served bytes can be cached as immutable.

export const AVATAR_SIZES = [24, 32, 40, 64, 96, 128, 256] as const;
export const AVATAR_HASH_RE = /^[0-9a-f]{16}$/;
const URL_RE = /^\/api\/avatars\/[0-9a-f-]{36}\/([0-9a-f]{16})$/;

export function snapAvatarSize(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return 64;
  return AVATAR_SIZES.find((s) => s >= n) ?? 256;
}

export const avatarKey = (userId: string, hash: string) => `avatars/${userId}/${hash}`;
export const avatarUrl = (userId: string, hash: string) => `/api/avatars/${userId}/${hash}`;

export function hashFromAvatarUrl(image: string | null | undefined): string | null {
  return image?.match(URL_RE)?.[1] ?? null;
}

export function avatarSrc(image: string, px: number): string {
  return `${image}?s=${snapAvatarSize(px)}`;
}
```

- [ ] **Step 5: Add the `fill` option to `lib/imgproxy.ts`**

Replace the signature and path lines of `imgproxyUrl`:

```ts
export function imgproxyUrl(
  storageKey: string,
  { width = 1600, height = 0, quality = 82, fill = false } = {}
): string {
  const source = `s3://${requireEnv("S3_BUCKET")}/${storageKey}`;
  const encoded = Buffer.from(source).toString("base64url");
  // fill: crop to an exact box (avatars), centred, enlarging small originals.
  const resize = fill
    ? `rs:fill:${width}:${height || width}:1/g:ce`
    : `rs:fit:${width}:0`;
  const path = `/${resize}/q:${quality}/${encoded}`;
```

Keep the signing lines unchanged. Update the doc comment to mention `fill`.

- [ ] **Step 6: Write `lib/avatars.ts`**

```ts
import "server-only";

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { avatarKey, avatarUrl, hashFromAvatarUrl } from "@/lib/avatar-url";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { sniffImage } from "@/lib/image-sniff";
import { deleteObject, putObject } from "@/lib/storage";

// Avatars are stored as uploaded (imgproxy crops and re-encodes on read) under
// avatars/<userId>/<hash>. GIF is refused: animated avatars are noise in lists.

async function currentImage(userId: string): Promise<string | null> {
  const [row] = await db.select({ image: users.image }).from(users).where(eq(users.id, userId));
  return row?.image ?? null;
}

async function dropObject(userId: string, hash: string | null) {
  if (!hash) return;
  // An orphan is harmless; never fail the request over it.
  await deleteObject(avatarKey(userId, hash)).catch((error) =>
    console.error(`avatar cleanup failed for ${userId}/${hash}:`, error)
  );
}

export async function storeAvatar(
  userId: string,
  bytes: Buffer,
  source: "upload" | "microsoft"
): Promise<{ ok: true; image: string } | { ok: false; error: "unsupported_type" }> {
  const kind = sniffImage(bytes);
  if (!kind || kind.mime === "image/gif") return { ok: false, error: "unsupported_type" };

  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const image = avatarUrl(userId, hash);
  const previous = await currentImage(userId);

  if (previous !== image) await putObject(avatarKey(userId, hash), bytes, kind.mime);
  await db
    .update(users)
    .set({ image, avatarSource: source, updatedAt: new Date() })
    .where(eq(users.id, userId));

  const oldHash = hashFromAvatarUrl(previous);
  if (oldHash !== hash) await dropObject(userId, oldHash);
  return { ok: true, image };
}

export async function removeAvatar(userId: string): Promise<void> {
  const previous = await currentImage(userId);
  await db
    .update(users)
    .set({ image: null, avatarSource: "removed", updatedAt: new Date() })
    .where(eq(users.id, userId));
  await dropObject(userId, hashFromAvatarUrl(previous));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/avatar.test.ts && bun run typecheck`
Expected: PASS.

If `requireEnv` reads `process.env` at import time in `lib/env`, `beforeAll` runs before the dynamic `import()`, so it still works.

- [ ] **Step 8: Commit**

```bash
git add lib/image-sniff.ts lib/avatar-url.ts lib/avatars.ts lib/imgproxy.ts app/api/knowledge/asset/route.ts tests/avatar.test.ts
git commit -m "feat(profile): avatar storage with content-hashed keys"
```

---

### Task 6: Avatar routes and Microsoft import

**Files:**
- Create: `app/api/avatars/route.ts`, `app/api/avatars/[userId]/[hash]/route.ts`, `app/api/avatars/microsoft/route.ts`, `lib/avatars-microsoft.ts`
- Modify: `lib/auth.ts` (hook and the `disableProfilePhoto` comment)

**Interfaces:**
- Consumes:
  - `storeAvatar`, `removeAvatar` (Task 5)
  - `snapAvatarSize`, `avatarKey`, `AVATAR_HASH_RE` (Task 5)
  - `imgproxyUrl` with `fill` (Task 5)
  - `AVATAR_MAX_BYTES` (Task 2)
- Produces:
  - `POST /api/avatars` (multipart field `file`) → `{ image }`, or `{ error: "no_file" | "too_large" | "unsupported_type" | "storage" }` with 400/413/415/502
  - `DELETE /api/avatars` → 204
  - `GET /api/avatars/:userId/:hash?s=N` → image, 404 when the object is missing
  - `POST /api/avatars/microsoft` → `{ result: ImportResult }`
  - `importMicrosoftAvatar(userId: string, opts?: { force?: boolean }): Promise<ImportResult>`, where `type ImportResult = "imported" | "unchanged" | "skipped" | "no_photo" | "no_account"`

- [ ] **Step 1: Write `app/api/avatars/route.ts`**

```ts
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import { getServerSession } from "@/lib/auth-session";
import { removeAvatar, storeAvatar } from "@/lib/avatars";
import { AVATAR_MAX_BYTES } from "@/lib/validation";

// Self-service only: the session user is the subject, never a path param.

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > AVATAR_MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let result: Awaited<ReturnType<typeof storeAvatar>>;
  try {
    result = await storeAvatar(session.user.id, Buffer.from(await file.arrayBuffer()), "upload");
  } catch (error) {
    console.error("Avatar upload failed:", error);
    return NextResponse.json({ error: "storage" }, { status: 502 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 415 });

  await recordActivity({
    actorId: session.user.id,
    action: "profile.updated",
    entityType: "user",
    entityId: session.user.id,
    data: { user: session.user.name },
  });
  revalidatePath("/", "layout");
  return NextResponse.json({ image: result.image });
}

export async function DELETE(): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  await removeAvatar(session.user.id);
  revalidatePath("/", "layout");
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 2: Write `app/api/avatars/[userId]/[hash]/route.ts`**

```ts
import { getServerSession } from "@/lib/auth-session";
import { AVATAR_HASH_RE, avatarKey, snapAvatarSize } from "@/lib/avatar-url";
import { imgproxyUrl } from "@/lib/imgproxy";
import { uuidSchema } from "@/lib/validation";

/**
 * Serve an avatar at a fixed size. Every signed-in user may see every avatar.
 * The path is content-addressed, so the response is immutable. A superseded
 * hash 404s once its object is deleted and <UserAvatar> falls back to initials.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string; hash: string }> }
): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { userId, hash } = await params;
  if (!uuidSchema.safeParse(userId).success || !AVATAR_HASH_RE.test(hash)) {
    return new Response("Bad request", { status: 400 });
  }
  const size = snapAvatarSize(new URL(request.url).searchParams.get("s"));

  let upstream: Response;
  try {
    upstream = await fetch(imgproxyUrl(avatarKey(userId, hash), { width: size, fill: true }), {
      headers: { Accept: request.headers.get("accept") ?? "image/*" },
    });
  } catch (error) {
    console.error(`imgproxy fetch failed for avatar ${userId}/${hash}:`, error);
    return new Response("Image service error", { status: 502 });
  }
  if (upstream.status === 404) return new Response("Not found", { status: 404 });
  if (!upstream.ok || !upstream.body) {
    console.error(`imgproxy returned ${upstream.status} for avatar ${userId}/${hash}`);
    return new Response("Image service error", { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/webp",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      Vary: "Accept",
    },
  });
}
```

Check what imgproxy returns for a missing S3 object: with `IMGPROXY_FALLBACK_IMAGE_*` unset it is 404. Verify manually in Task 13 (M5). If your imgproxy returns 422 instead, also map `upstream.status === 422` to 404, and comment why.

- [ ] **Step 3: Write `lib/avatars-microsoft.ts`**

```ts
import "server-only";

import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { storeAvatar } from "@/lib/avatars";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export type ImportResult = "imported" | "unchanged" | "skipped" | "no_photo" | "no_account";

const PHOTO_URL = "https://graph.microsoft.com/v1.0/me/photos/240x240/$value";

/**
 * Copy the user's Microsoft 365 photo into our avatar store. Runs after every
 * Microsoft sign-in, so a photo changed in M365 follows. An uploaded or
 * deliberately removed avatar is left alone unless `force` (the "Use Microsoft
 * photo" button). Identical bytes hash to the same key, so a re-import is a
 * no-op write.
 */
export async function importMicrosoftAvatar(
  userId: string,
  { force = false }: { force?: boolean } = {}
): Promise<ImportResult> {
  const user = await db.query.users.findFirst({
    where: { id: userId },
    columns: { avatarSource: true, image: true },
  });
  if (!user) return "skipped";
  if (!force && user.avatarSource !== null && user.avatarSource !== "microsoft") return "skipped";

  const account = await db.query.accounts.findFirst({
    where: { userId, providerId: "microsoft" },
    columns: { id: true },
  });
  if (!account) return "no_account";

  // Refreshes the token if it is about to expire.
  const { accessToken } = await auth.api.getAccessToken({
    body: { accountId: account.id, userId },
  });
  const res = await fetch(PHOTO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return "no_photo";
  if (!res.ok) throw new Error(`Graph photo request failed: ${res.status}`);

  const before = user.image;
  const result = await storeAvatar(userId, Buffer.from(await res.arrayBuffer()), "microsoft");
  if (!result.ok) return "no_photo";
  return result.image === before ? "unchanged" : "imported";
}
```

Check that `db.query.accounts` exists in `lib/db/relations.ts`; `accounts` is in the schema. If RQB v2 rejects the object `where` shape for `accounts`, use `db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.providerId, "microsoft"))).limit(1)`.

- [ ] **Step 4: Hook the import into sign-in (`lib/auth.ts`)**

Add the imports `import { createAuthMiddleware } from "better-auth/api";` and `import { after } from "next/server";`, then add a top-level option:

```ts
  hooks: {
    // After a Microsoft sign-in, pull the M365 photo in the background.
    // after() runs it once the response is sent, so sign-in never waits on
    // Graph, and a failure only logs. Dynamic import: lib/avatars-microsoft
    // imports this module.
    after: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith("/callback") || ctx.params?.id !== "microsoft") return;
      const userId = ctx.context.newSession?.user.id;
      if (!userId) return;
      after(async () => {
        const { importMicrosoftAvatar } = await import("@/lib/avatars-microsoft");
        await importMicrosoftAvatar(userId).catch((error) =>
          console.error("Microsoft avatar import failed:", error)
        );
      });
    }),
  },
```

Update the `disableProfilePhoto` comment:

```ts
          // Entra hands back a Graph photo URL that needs a bearer token, so
          // better-auth can't store a usable `image`. lib/avatars-microsoft
          // copies the photo into our own store after sign-in instead.
```

If `lib/terminal/main.ts` (run by plain Bun) imports `lib/auth`, make sure `next/server`'s `after` import doesn't crash at module load: run `bun run lib/terminal/main.ts --help` or start it briefly. `after` is only *called* inside a Next request, so importing it is fine. If the import does throw under Bun, move the hook body into `lib/auth-hooks.ts` and import that lazily.

- [ ] **Step 5: Write `app/api/avatars/microsoft/route.ts`**

```ts
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth-session";
import { importMicrosoftAvatar } from "@/lib/avatars-microsoft";

/** "Use Microsoft photo": forced import for the signed-in user. */
export async function POST(): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  try {
    const result = await importMicrosoftAvatar(session.user.id, { force: true });
    revalidatePath("/", "layout");
    return NextResponse.json({ result });
  } catch (error) {
    console.error("Forced Microsoft avatar import failed:", error);
    return NextResponse.json({ error: "graph" }, { status: 502 });
  }
}
```

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun run lint && bun test`
Expected: clean.

Then smoke-test locally with `bun run dev` and a signed-in browser session cookie in `$COOKIE`:
- `curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/avatars/00000000-0000-7000-8000-000000000000/0123456789abcdef -H "cookie: $COOKIE"` → `404`
- the same without the cookie → `401`

- [ ] **Step 7: Commit**

```bash
git add app/api/avatars lib/avatars-microsoft.ts lib/auth.ts
git commit -m "feat(profile): avatar upload/serve routes and Microsoft photo import"
```

---

### Task 7: Shared user components and the hover card

**Files:**
- Create:
  - `components/ui/preview-card.tsx`
  - `components/user/user-avatar.tsx`, `components/user/user-name.tsx`, `components/user/user-card.tsx`
  - `components/user/user-card-cache.ts`, `components/user/local-time.tsx`
  - `lib/people/card.ts`, `app/api/users/[id]/card/route.ts`
- Modify: `lib/types.ts`, `messages/*.json` (new `people` namespace)
- Test: `tests/user-card.test.ts`

**Interfaces:**
- Consumes:
  - `getInitials`, `avatarColorIndex`, `activeStatus`, `isWithinWorkingHours`, `nextWorkingStart`, `WorkingHours` (Task 1)
  - `avatarSrc` (Task 5)
  - `effectiveTimeZone` (Task 2)
- Produces:
  - `type UserRef = { id: string; name: string; image: string | null }` in `lib/types.ts`
  - `type UserCardData`, below
  - `<UserAvatar user size? className? label? />`, with `size: "xs" | "sm" | "md" | "lg" | "xl"` (20/24/32/64/128 px, default `"sm"`)
  - `<UserName user avatar? className? />`, with `user: UserRef | null`
  - `<LocalTime timeZone workingHours? />`
  - `loadUserCard(id: string): Promise<UserCardData>`
  - `getUserCard(id: string, viewer: { id: string; role: string }): Promise<UserCardData | null>`
  - `jiraProfileUrl(baseUrl: string, accountId: string): string`

```ts
// in lib/types.ts
export type UserRef = { id: string; name: string; image: string | null };

export type UserCardData = UserRef & {
  email: string;
  title: string | null;
  bio: string | null;
  role: string;
  timeZone: string;
  workingHours: { days: number[]; start: string; end: string } | null;
  status: { emoji: string | null; text: string | null; expiresAt: string | null } | null;
  jiraUrl: string | null;
  deactivated: boolean;
};
```

- [ ] **Step 1: Write the failing test for the server query helpers**

```ts
// tests/user-card.test.ts
import { describe, expect, it } from "bun:test";
import { jiraProfileUrl } from "@/lib/people/card";

describe("jiraProfileUrl", () => {
  it("builds a cloud people url without a double slash", () => {
    expect(jiraProfileUrl("https://acme.atlassian.net/", "5f1c")).toBe("https://acme.atlassian.net/jira/people/5f1c");
  });
  it("encodes the account id", () => {
    expect(jiraProfileUrl("https://acme.atlassian.net", "a/b")).toBe("https://acme.atlassian.net/jira/people/a%2Fb");
  });
});
```

Run: `bun test tests/user-card.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 2: Write `lib/people/card.ts`**

```ts
import "server-only";

import { db } from "@/lib/db";
import { canOrg } from "@/lib/permissions";
import { effectiveTimeZone } from "@/lib/timezone";
import type { UserCardData } from "@/lib/types";
import { activeStatus } from "@/lib/user-display";

export function jiraProfileUrl(baseUrl: string, accountId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/jira/people/${encodeURIComponent(accountId)}`;
}

/**
 * Profile fields only: no project data, so the card is safe to show to any
 * signed-in user. Deactivated (banned) users are visible to user admins only.
 */
export async function getUserCard(
  id: string,
  viewer: { role: string | null | undefined }
): Promise<UserCardData | null> {
  const user = await db.query.users.findFirst({
    where: { id },
    columns: {
      id: true, name: true, email: true, image: true, title: true, bio: true,
      role: true, timezone: true, workingHours: true, banned: true,
      statusEmoji: true, statusText: true, statusExpiresAt: true, jiraAccountId: true,
    },
  });
  if (!user) return null;
  if (user.banned && !canOrg(viewer.role, { user: ["list"] })) return null;

  let jiraUrl: string | null = null;
  if (user.jiraAccountId) {
    const conn = await db.query.jiraConnections.findFirst({
      where: { flavor: "cloud" },
      columns: { baseUrl: true },
    });
    if (conn) jiraUrl = jiraProfileUrl(conn.baseUrl, user.jiraAccountId);
  }

  const status = activeStatus(user);
  return {
    id: user.id,
    name: user.name,
    image: user.image,
    email: user.email,
    title: user.title,
    bio: user.bio,
    role: user.role,
    timeZone: effectiveTimeZone(user),
    workingHours: user.workingHours ?? null,
    status: status && { ...status, expiresAt: status.expiresAt?.toISOString() ?? null },
    jiraUrl,
    deactivated: user.banned,
  };
}
```

Run: `bun test tests/user-card.test.ts`
Expected: PASS.

- [ ] **Step 3: Write `app/api/users/[id]/card/route.ts`**

```ts
import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth-session";
import { getUserCard } from "@/lib/people/card";
import { uuidSchema } from "@/lib/validation";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return new Response("Bad request", { status: 400 });
  const card = await getUserCard(id, session.user);
  if (!card) return new Response("Not found", { status: 404 });
  // Status and name change; let the client cache (60 s) do the work.
  return NextResponse.json(card, { headers: { "Cache-Control": "private, no-store" } });
}
```

- [ ] **Step 4: Write `components/ui/preview-card.tsx`**

Mirror `components/ui/popover.tsx`:

```tsx
"use client"

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card"

import { cn } from "@/lib/utils"

function PreviewCard({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root data-slot="preview-card" {...props} />
}

function PreviewCardTrigger({ ...props }: PreviewCardPrimitive.Trigger.Props) {
  return <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />
}

function PreviewCardContent({
  className,
  align = "start",
  side = "bottom",
  sideOffset = 6,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<PreviewCardPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="preview-card-content"
          className={cn(
            "z-50 w-80 origin-(--transform-origin) rounded-md bg-popover p-4 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  )
}

export { PreviewCard, PreviewCardContent, PreviewCardTrigger }
```

Check the delay prop names in `node_modules/@base-ui/react/preview-card/trigger/PreviewCardTrigger.d.ts` (`delay`/`closeDelay` on Trigger in 1.x). Use the defaults; do not hard-code.

- [ ] **Step 5: Write `components/user/user-avatar.tsx`**

```tsx
"use client";

import { useState } from "react";
import { avatarSrc } from "@/lib/avatar-url";
import type { UserRef } from "@/lib/types";
import { avatarColorIndex, getInitials } from "@/lib/user-display";
import { cn } from "@/lib/utils";

const SIZES = { xs: 20, sm: 24, md: 32, lg: 64, xl: 128 } as const;
export type AvatarSize = keyof typeof SIZES;

const TEXT = { xs: "text-[9px]", sm: "text-[10px]", md: "text-xs", lg: "text-xl", xl: "text-4xl" } as const;

// 100/900 pairs keep initials at AA contrast in both themes.
const COLORS = [
  "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  "bg-rose-100 text-rose-900 dark:bg-rose-900 dark:text-rose-100",
  "bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
  "bg-teal-100 text-teal-900 dark:bg-teal-900 dark:text-teal-100",
  "bg-orange-100 text-orange-900 dark:bg-orange-900 dark:text-orange-100",
  "bg-indigo-100 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100",
] as const;

export function UserAvatar({
  user,
  size = "sm",
  className,
  label,
}: {
  user: Pick<UserRef, "id" | "name" | "image"> & { email?: string };
  size?: AvatarSize;
  className?: string;
  /** Accessible name when the avatar stands alone (no adjacent name). */
  label?: string;
}) {
  const px = SIZES[size];
  const [failed, setFailed] = useState(false);
  const box = cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full select-none", className);
  const style = { width: px, height: px };

  if (user.image && !failed) {
    return (
      <img
        src={avatarSrc(user.image, px)}
        srcSet={`${avatarSrc(user.image, px)} 1x, ${avatarSrc(user.image, px * 2)} 2x`}
        alt={label ?? ""}
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(box, "object-cover bg-muted")}
        style={style}
      />
    );
  }
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(box, "font-semibold", TEXT[size], COLORS[avatarColorIndex(user.id)])}
      style={style}
    >
      {getInitials(user.name, user.email)}
    </span>
  );
}
```

The `<img>` is intentional (imgproxy already optimises). If Biome flags `noImgElement` (Next lint rule), add a `// biome-ignore` with that reason.

- [ ] **Step 6: Write `components/user/user-card-cache.ts`**

```ts
"use client";

import type { UserCardData } from "@/lib/types";

// One in-flight or settled request per user, reused for 60 s, so hovering the
// same name across a list costs one fetch. Failures are evicted so the next
// hover retries.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; promise: Promise<UserCardData> }>();

export function loadUserCard(id: string): Promise<UserCardData> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fetch(`/api/users/${id}/card`).then((res) => {
    if (!res.ok) throw new Error(`card ${res.status}`);
    return res.json() as Promise<UserCardData>;
  });
  promise.catch(() => cache.delete(id));
  cache.set(id, { at: Date.now(), promise });
  return promise;
}
```

- [ ] **Step 7: Write `components/user/local-time.tsx`**

```tsx
"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { isWithinWorkingHours, nextWorkingStart, type WorkingHours } from "@/lib/user-display";

/** "14:03 local time · GMT+8 · outside working hours, back Mon 09:00". Ticks each minute. */
export function LocalTime({ timeZone, workingHours }: { timeZone: string; workingHours: WorkingHours | null }) {
  const t = useTranslations("people");
  const format = useFormatter();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Rendered after mount only: the server can't know the viewer's clock minute.
  if (!now) return <span className="text-muted-foreground">&nbsp;</span>;

  const time = format.dateTime(now, { timeZone, hour: "2-digit", minute: "2-digit" });
  const offset = format.dateTime(now, { timeZone, timeZoneName: "shortOffset" }).split(" ").pop();
  let state: string | null = null;
  if (workingHours) {
    if (isWithinWorkingHours(workingHours, timeZone, now)) state = t("workingNow");
    else {
      const next = nextWorkingStart(workingHours, timeZone, now);
      if (next) {
        const day = format.dateTime(new Date(now.getTime() + next.daysAhead * 86_400_000), { timeZone, weekday: "short" });
        state =
          next.daysAhead === 0
            ? t("backToday", { time: next.start })
            : next.daysAhead === 1
              ? t("backTomorrow", { time: next.start })
              : t("backOn", { day, time: next.start });
      }
    }
  }
  return (
    <span className="text-muted-foreground">
      {t("localTime", { time })} · {offset}
      {state && <> · {state}</>}
    </span>
  );
}
```

Add to the `people` namespace (all 5 locales):
- `localTime`: "{time} local time"
- `workingNow`: "working hours"
- `backToday`: "outside working hours, back at {time}"
- `backTomorrow`: "outside working hours, back tomorrow {time}"
- `backOn`: "outside working hours, back {day} {time}"

- [ ] **Step 8: Write `components/user/user-card.tsx` and `user-name.tsx`**

```tsx
// components/user/user-card.tsx
"use client";

import { Mail, MessageSquare, SquareArrowOutUpRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { use } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import type { UserCardData } from "@/lib/types";
import { LocalTime } from "./local-time";
import { UserAvatar } from "./user-avatar";

export function teamsChatUrl(email: string) {
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`;
}

export function UserCardBody({ promise, fallbackName, id }: { promise: Promise<UserCardData>; fallbackName: string; id: string }) {
  const t = useTranslations("people");
  const tRoles = useTranslations("users.role");
  const format = useFormatter();
  const card = use(promise);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <UserAvatar user={card} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{card.name}</span>
            {card.deactivated && <Badge variant="secondary">{t("deactivated")}</Badge>}
          </div>
          {card.title && <p className="truncate text-muted-foreground">{card.title}</p>}
          <Badge variant="outline" className="mt-1">{tRoles(card.role)}</Badge>
        </div>
      </div>
      {card.status && (
        <p className="text-sm">
          {card.status.emoji} {card.status.text}
          {card.status.expiresAt && (
            <span className="text-muted-foreground">
              {" · "}{t("until", { date: format.dateTime(new Date(card.status.expiresAt), { dateStyle: "medium", timeStyle: "short" }) })}
            </span>
          )}
        </p>
      )}
      <p className="text-xs"><LocalTime timeZone={card.timeZone} workingHours={card.workingHours} /></p>
      {card.bio && <p className="line-clamp-2 text-sm text-muted-foreground whitespace-pre-line">{card.bio}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" render={<a href={`mailto:${card.email}`} />}>
          <Mail />{t("email")}
        </Button>
        <Button size="sm" variant="outline" render={<a href={teamsChatUrl(card.email)} target="_blank" rel="noreferrer" />}>
          <MessageSquare />{t("teams")}
        </Button>
        <Button size="sm" variant="ghost" render={<Link href={`/people/${id}`} />}>
          <SquareArrowOutUpRight />{t("viewProfile")}
        </Button>
      </div>
      <span className="sr-only">{fallbackName}</span>
    </div>
  );
}

export function UserCardSkeleton() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="size-16 rounded-full" />
      <div className="flex flex-1 flex-col gap-2 pt-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}
```

```tsx
// components/user/user-name.tsx
"use client";

import { useTranslations } from "next-intl";
import { Component, type ReactNode, Suspense, useState } from "react";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/components/ui/preview-card";
import { Link } from "@/i18n/navigation";
import type { UserCardData, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type AvatarSize, UserAvatar } from "./user-avatar";
import { UserCardBody, UserCardSkeleton } from "./user-card";
import { loadUserCard } from "./user-card-cache";

class CardBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A user's name as a link to their profile, with a hover/focus card. On touch
 * devices the card doesn't open and a tap navigates. Everything on the card
 * is also on the profile page.
 */
export function UserName({
  user,
  avatar,
  className,
}: {
  user: UserRef | null;
  avatar?: AvatarSize | boolean;
  className?: string;
}) {
  const t = useTranslations("people");
  const [promise, setPromise] = useState<Promise<UserCardData> | null>(null);
  if (!user) return <span className={cn("text-muted-foreground", className)}>{t("deletedUser")}</span>;

  // Start fetching on intent, before the open delay elapses.
  const prefetch = () => setPromise((p) => p ?? loadUserCard(user.id));
  const size: AvatarSize = avatar === true ? "xs" : avatar || "xs";

  return (
    <PreviewCard onOpenChange={(open) => open && prefetch()}>
      <PreviewCardTrigger
        render={<Link href={`/people/${user.id}`} />}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        className={cn("inline-flex min-w-0 items-center gap-1.5 hover:underline underline-offset-2", className)}
      >
        {avatar ? <UserAvatar user={user} size={size} /> : null}
        <span className="truncate">{user.name}</span>
      </PreviewCardTrigger>
      <PreviewCardContent>
        {promise && (
          <CardBoundary fallback={<Link href={`/people/${user.id}`} className="font-medium hover:underline">{user.name} · {t("viewProfile")}</Link>}>
            <Suspense fallback={<UserCardSkeleton />}>
              <UserCardBody promise={promise} fallbackName={user.name} id={user.id} />
            </Suspense>
          </CardBoundary>
        )}
      </PreviewCardContent>
    </PreviewCard>
  );
}
```

Add to `people` (5 locales):
- `deletedUser`: "Deleted user"
- `viewProfile`: "View profile"
- `email`: "Email"
- `teams`: "Chat in Teams"
- `deactivated`: "Deactivated"
- `until`: "until {date}"

Role labels come from the existing `users.role.<role>` keys.

- [ ] **Step 9: Verify**

Run: `bun run typecheck && bun run lint && bun test`
Expected: clean.

Temporarily render `<UserName user={{ id: session.user.id, name: session.user.name, image: session.user.image ?? null }} avatar />` in `app/[locale]/(home)/page.tsx`, hover it in `bun run dev`, see the card, then remove it.

- [ ] **Step 10: Commit**

```bash
git add components/ui/preview-card.tsx components/user lib/people/card.ts lib/types.ts app/api/users tests/user-card.test.ts messages
git commit -m "feat(profile): UserAvatar, UserName and the lazy hover card"
```

---

### Task 8: Per-user timezone

**Files:**
- Modify: `i18n/request.ts`, `app/[locale]/layout.tsx:44,152,200`, `app/[locale]/(home)/page.tsx:17,55`, `components/server-time.tsx`, `app/[locale]/[projectKey]/[envSlug]/mock-time/date-time-picker.tsx`
- Create: `components/user/timezone-hint.tsx`

**Interfaces:**
- Consumes:
  - `effectiveTimeZone` (Task 2)
  - `updateProfile` (Task 4). The hint calls a narrower action, below.
  - session `timezone` (Task 3)
- Produces: `setMyTimeZone(timezone: string): Promise<ActionResponse>`, in `actions/profile.ts`.

- [ ] **Step 1: Make next-intl use the reader's zone**

In `i18n/request.ts`, replace the `APP_TIMEZONE` import with:

```ts
import { getServerSession } from "../lib/auth-session";
import { effectiveTimeZone } from "../lib/timezone";
```

and return:

```ts
  return {
    locale,
    messages: applyBranding(raw),
    // The reader's own zone. getServerSession is request-memoised, so this
    // adds no query on pages that already read the session.
    timeZone: effectiveTimeZone((await getServerSession())?.user),
  };
```

`getServerSession` calls `headers()`. That is fine here, because every page under `[locale]` already reads the session in the layout and is dynamic. If the build reports `/sign-in` or another static page turning dynamic, wrap the call in `try { … } catch { return APP_TIMEZONE }` only for that case.

- [ ] **Step 2: Layout and Home**

In `app/[locale]/layout.tsx`:
- `NextIntlClientProvider timeZone={effectiveTimeZone(session?.user)}`
- keep `<ServerTime timeZone={APP_TIMEZONE} />`, because it is explicitly server time

In `app/[locale]/(home)/page.tsx`, change the greeting to `hourIn(effectiveTimeZone(session.user), new Date())` and import `effectiveTimeZone` in place of `APP_TIMEZONE`.

- [ ] **Step 3: Label server time and the mock-time picker**

In `components/server-time.tsx`, add `aria-label={t("serverTime", { zone: timeZone })}` to the outer span and prefix the `title` with the same text. Use `useTranslations("header")`.

In `date-time-picker.tsx`, under the time field, add `<p className="text-xs text-muted-foreground">{t("browserZone", { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>`. Compute the zone in a `useEffect` and keep it in state, to avoid a hydration mismatch.

i18n (5 locales):
- `header.serverTime`: "Server time ({zone})"
- `mockTime.browserZone`: "Time is in your browser's zone ({zone})"

The picker's namespace may not be `mockTime`; reuse the namespace it already calls `useTranslations` with.

- [ ] **Step 4: Timezone hint**

Add to `actions/profile.ts`:

```ts
export async function setMyTimeZone(timezone: string): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  if (!timeZoneSchema.safeParse(timezone).success) return { success: false, message: t("invalidInput") };
  await db.update(users).set({ timezone, updatedAt: new Date() }).where(eq(users.id, session.user.id));
  revalidatePath("/", "layout");
  return { success: true, message: t("profileUpdated") };
}
```

(import `timeZoneSchema`). Then create `components/user/timezone-hint.tsx`:

```tsx
"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { setMyTimeZone } from "@/actions/profile";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "tz-hint-dismissed";

/** Shown once to a user with no saved zone whose browser disagrees with the app's. */
export function TimezoneHint({ appTimeZone }: { appTimeZone: string }) {
  const t = useTranslations("profile");
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zone !== appTimeZone && !localStorage.getItem(DISMISS_KEY)) setBrowserZone(zone);
  }, [appTimeZone]);

  if (!browserZone) return null;
  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setBrowserZone(null);
  };
  return (
    <div role="status" className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="flex-1">{t("tzHint", { zone: browserZone })}</span>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await setMyTimeZone(browserZone);
            if (res.success) dismiss();
            else toast.error(res.message);
          })
        }
      >
        {t("tzHintUse")}
      </Button>
      <Button size="icon" variant="ghost" aria-label={t("tzHintDismiss")} onClick={dismiss}>
        <X />
      </Button>
    </div>
  );
}
```

Render it in `layout.tsx` as the first child of `<main>`, only when `session.user.timezone == null`: `{!session.user.timezone && <TimezoneHint appTimeZone={APP_TIMEZONE} />}`.

i18n `profile` namespace (5 locales):
- `tzHint`: "Your timezone looks like {zone}. Show times in it?"
- `tzHintUse`: "Use it"
- `tzHintDismiss`: "Dismiss"

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: clean, and the build reports no new static/dynamic errors.

In dev, set your zone with SQL (`UPDATE users SET timezone='America/New_York' WHERE email=…`). Dates on an issue page shift by the offset, and the header server time does not.

- [ ] **Step 6: Commit**

```bash
git add i18n/request.ts app/[locale]/layout.tsx "app/[locale]/(home)/page.tsx" components/server-time.tsx app/[locale]/[projectKey]/[envSlug]/mock-time/date-time-picker.tsx components/user/timezone-hint.tsx actions/profile.ts messages
git commit -m "feat(profile): render dates in the reader's timezone"
```

---

### Task 9: Account profile form and avatar cropper

**Files:**
- Create: `app/[locale]/account/profile-form.tsx`, `components/user/avatar-cropper.tsx`, `components/user/timezone-select.tsx`
- Modify: `app/[locale]/account/page.tsx`
- Delete: `app/[locale]/account/profile-card.tsx`

**Interfaces:**
- Consumes:
  - `updateProfile` (Task 4)
  - `POST/DELETE /api/avatars`, `POST /api/avatars/microsoft` (Task 6)
  - `UserAvatar` (Task 7)
  - `PROFILE_LIMITS` (Task 2)
- Produces:
  - `<AvatarCropper file onCancel onCropped(blob: Blob) />`
  - `<TimezoneSelect value onChange />`

- [ ] **Step 1: `components/user/avatar-cropper.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const VIEW = 256; // on-screen viewport, px
const OUT = 512; // exported square, px

/** Square crop with drag-to-pan and a zoom slider. Exports WebP (PNG fallback). */
export function AvatarCropper({
  file,
  onCancel,
  onCropped,
}: {
  file: File;
  onCancel: () => void;
  onCropped: (blob: Blob) => void;
}) {
  const t = useTranslations("profile");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Scale so the shorter side covers the viewport at zoom 1.
  const base = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = (img?.naturalWidth ?? 0) * scale;
  const h = (img?.naturalHeight ?? 0) * scale;
  const clamp = (o: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(VIEW - w, o.x)),
    y: Math.min(0, Math.max(VIEW - h, o.y)),
  });
  const pos = clamp(offset.x === 0 && offset.y === 0 ? { x: (VIEW - w) / 2, y: (VIEW - h) / 2 } : offset);

  function exportCrop() {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const k = OUT / VIEW;
    ctx.drawImage(img, pos.x * k, pos.y * k, w * k, h * k);
    canvas.toBlob(
      (blob) => {
        if (blob?.type === "image/webp") onCropped(blob);
        else canvas.toBlob((png) => png && onCropped(png), "image/png");
      },
      "image/webp",
      0.9
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("cropTitle")}</DialogTitle>
        </DialogHeader>
        <div
          className="relative mx-auto touch-none overflow-hidden rounded-full bg-muted cursor-grab active:cursor-grabbing"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
          }}
          onPointerMove={(e) => {
            if (drag.current) setOffset(clamp({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          {img && (
            // biome-ignore lint/performance/noImgElement: local object URL preview
            <img src={img.src} alt="" draggable={false} className="absolute max-w-none select-none" style={{ left: pos.x, top: pos.y, width: w, height: h }} />
          )}
        </div>
        <input
          type="range"
          min={1}
          max={4}
          step={0.01}
          value={zoom}
          aria-label={t("zoom")}
          onChange={(e) => {
            setZoom(Number(e.target.value));
            setOffset((o) => clamp(o));
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("cancel")}</Button>
          <Button onClick={exportCrop} disabled={!img}>{t("saveAvatar")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Pan is on the X axis in screen space, so it needs no RTL handling. Check the `DialogFooter` and `DialogHeader` export names in `components/ui/dialog.tsx` (lines 146-160) and adjust the import if they differ.

- [ ] **Step 2: `components/user/timezone-select.tsx`**

A searchable list built on the existing `Command` + `Popover` (same pattern as the command palette):

```tsx
"use client";

import { ChevronsUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** IANA zone picker. `null` means "use the organisation default". */
export function TimezoneSelect({
  value,
  defaultZone,
  onChange,
}: {
  value: string | null;
  defaultZone: string;
  onChange: (zone: string | null) => void;
}) {
  const t = useTranslations("profile");
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" className="w-full justify-between font-normal" />}>
        {value ?? t("tzDefault", { zone: defaultZone })}
        <ChevronsUpDown className="opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) p-0">
        <Command>
          <CommandInput placeholder={t("tzSearch")} />
          <CommandList>
            <CommandEmpty>{t("tzNone")}</CommandEmpty>
            <CommandItem value={`default ${defaultZone}`} onSelect={() => { onChange(null); setOpen(false); }}>
              {t("tzDefault", { zone: defaultZone })}
            </CommandItem>
            {zones.map((zone) => (
              <CommandItem key={zone} value={zone} onSelect={() => { onChange(zone); setOpen(false); }}>
                {zone.replaceAll("_", " ")}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: `app/[locale]/account/profile-form.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateProfile } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AvatarCropper } from "@/components/user/avatar-cropper";
import { TimezoneSelect } from "@/components/user/timezone-select";
import { UserAvatar } from "@/components/user/user-avatar";
import { Link, useRouter } from "@/i18n/navigation";
import { PROFILE_LIMITS } from "@/lib/validation";
import type { WorkingHours } from "@/lib/user-display";

type ProfileUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  title: string | null;
  bio: string | null;
  timezone: string | null;
  workingHours: WorkingHours | null;
};

const DEFAULT_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

export function ProfileForm({
  user,
  appTimeZone,
  hasMicrosoft,
}: {
  user: ProfileUser;
  appTimeZone: string;
  hasMicrosoft: boolean;
}) {
  const t = useTranslations("profile");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(user.name);
  const [title, setTitle] = useState(user.title ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [timezone, setTimezone] = useState(user.timezone);
  const [hours, setHours] = useState<WorkingHours | null>(user.workingHours);
  const [cropping, setCropping] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Weekday labels in the user's locale, Monday first (ISO 1..7).
  const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const weekdays = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    d,
    label: weekdayFmt.format(new Date(Date.UTC(2024, 0, d))), // 2024-01-01 is a Monday
  }));

  async function avatarRequest(init: RequestInit & { url?: string }) {
    const res = await fetch(init.url ?? "/api/avatars", init);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(t(`avatarError.${body.error ?? "storage"}`));
      return;
    }
    if (init.url) {
      const { result } = (await res.json()) as { result: string };
      if (result === "no_photo") return toast.info(t("avatarNoMicrosoftPhoto"));
    }
    router.refresh();
  }

  function onCropped(blob: Blob) {
    setCropping(null);
    const body = new FormData();
    body.set("file", blob, "avatar");
    startTransition(() => avatarRequest({ method: "POST", body }));
  }

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await updateProfile({ name, title, bio, timezone, workingHours: hours });
      if (res.success) {
        toast.success(res.message);
        router.refresh();
      } else toast.error(res.message);
    });
  }

  return (
    <form onSubmit={onSave} className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <UserAvatar user={user} size="lg" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => fileInput.current?.click()}>
            {t("uploadAvatar")}
          </Button>
          {hasMicrosoft && (
            <Button type="button" variant="outline" size="sm" disabled={pending}
              onClick={() => startTransition(() => avatarRequest({ method: "POST", url: "/api/avatars/microsoft" }))}>
              {t("useMicrosoftPhoto")}
            </Button>
          )}
          {user.image && (
            <Button type="button" variant="ghost" size="sm" disabled={pending}
              onClick={() => startTransition(() => avatarRequest({ method: "DELETE" }))}>
              {t("removeAvatar")}
            </Button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setCropping(f);
            e.target.value = "";
          }}
        />
      </div>
      {cropping && <AvatarCropper file={cropping} onCancel={() => setCropping(null)} onCropped={onCropped} />}

      <div className="grid gap-2">
        <Label htmlFor="pf-name">{t("name")}</Label>
        <Input id="pf-name" value={name} maxLength={PROFILE_LIMITS.name} required onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pf-title">{t("jobTitle")}</Label>
        <Input id="pf-title" value={title} maxLength={PROFILE_LIMITS.title} placeholder={t("jobTitlePlaceholder")} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pf-bio">{t("bio")}</Label>
        <Textarea id="pf-bio" value={bio} maxLength={PROFILE_LIMITS.bio} rows={3} onChange={(e) => setBio(e.target.value)} />
        <p className="text-xs text-muted-foreground text-end">{bio.length}/{PROFILE_LIMITS.bio}</p>
      </div>
      <div className="grid gap-2">
        <Label>{t("timezone")}</Label>
        <div className="flex gap-2">
          <div className="flex-1"><TimezoneSelect value={timezone} defaultZone={appTimeZone} onChange={setTimezone} /></div>
          <Button type="button" variant="outline" onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>
            {t("detectTimezone")}
          </Button>
        </div>
      </div>
      <div className="grid gap-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="pf-hours">{t("workingHours")}</Label>
          <Switch id="pf-hours" checked={hours !== null} onCheckedChange={(on) => setHours(on ? DEFAULT_HOURS : null)} />
        </div>
        {hours && (
          <>
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("workingDays")}>
              {weekdays.map(({ d, label }) => {
                const on = hours.days.includes(d);
                return (
                  <Button key={d} type="button" size="sm" variant={on ? "default" : "outline"} aria-pressed={on}
                    onClick={() => setHours({ ...hours, days: on ? hours.days.filter((x) => x !== d) : [...hours.days, d].sort() })}>
                    {label}
                  </Button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Input type="time" className="w-32" aria-label={t("start")} value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} />
              <span aria-hidden>–</span>
              <Input type="time" className="w-32" aria-label={t("end")} value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} />
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{t("save")}</Button>
        <Link href={`/people/${user.id}`} className="text-sm underline underline-offset-2">{t("viewPublicProfile")}</Link>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Wire the account page**

In `app/[locale]/account/page.tsx`:
- Replace `<ProfileCard …/>` with a `Card` (title `t("profile.title")`, description `t("profile.description")`) whose `CardContent` renders `<ProfileForm user={…} appTimeZone={APP_TIMEZONE} hasMicrosoft={hasMicrosoft} />`.
- Fill `user` from `session.user`: `id`, `name`, `email`, `image ?? null`, `title ?? null`, `bio ?? null`, `timezone ?? null`, `workingHours ?? null`. Cast `workingHours` as `WorkingHours | null`, because better-auth types JSON as `Record<string, any>`.
- Compute `hasMicrosoft` with `db.query.accounts.findFirst({ where: { userId: session.user.id, providerId: "microsoft" }, columns: { id: true } })`.

Delete `profile-card.tsx` and remove `account.profile.nameManagedByAdmin` from all 5 locales.

i18n `profile` namespace (5 locales):
- `name`: "Display name"
- `jobTitle`: "Job title"
- `jobTitlePlaceholder`: "e.g. QA Engineer"
- `bio`: "Short bio"
- `timezone`: "Timezone"
- `tzDefault`: "Organisation default ({zone})"
- `tzSearch`: "Search timezones…"
- `tzNone`: "No timezone found"
- `detectTimezone`: "Detect"
- `workingHours`: "Working hours"
- `workingDays`: "Working days"
- `start`: "Start"
- `end`: "End"
- `save`: "Save profile"
- `viewPublicProfile`: "View public profile"
- `uploadAvatar`: "Upload photo"
- `useMicrosoftPhoto`: "Use Microsoft photo"
- `removeAvatar`: "Remove"
- `cropTitle`: "Crop your photo"
- `zoom`: "Zoom"
- `cancel`: "Cancel"
- `saveAvatar`: "Save photo"
- `avatarNoMicrosoftPhoto`: "Your Microsoft account has no photo."
- `avatarError`:
  - `no_file`: "Choose an image first."
  - `too_large`: "The image is larger than 5 MB."
  - `unsupported_type`: "Use a PNG, JPEG, WebP or AVIF image."
  - `storage`: "The photo couldn't be saved. Try again."
  - `graph`: "Microsoft didn't return your photo. Try again later."

Update `account.profile.description` to "How you appear to your teammates in {{APP_NAME}}."

- [ ] **Step 5: Verify in the browser**

Run: `bun run typecheck && bun run lint && bun test`, then `bun run dev`. Check each of the following:

1. Edit name, title and bio and save. A toast appears, and the sidebar name updates.
2. Change name to another user's name. You get "That name is already used…".
3. Upload a 3 MB JPEG, crop it, and save. The avatar appears in the form and in the user menu after Task 10.
4. Upload a renamed `.gif`. The toast is "Use a PNG, JPEG…".
5. Remove the avatar. Initials show.
6. Pick a timezone and save. Dates move.
7. Turn on working hours, set start ≥ end, and save. The toast is the invalid-input error.

- [ ] **Step 6: Commit**

```bash
git add app/[locale]/account components/user/avatar-cropper.tsx components/user/timezone-select.tsx messages
git rm app/[locale]/account/profile-card.tsx
git commit -m "feat(profile): editable profile with avatar crop, timezone and working hours"
```

---

### Task 10: Status popover and user-menu entry points

**Files:**
- Create: `components/user/status-popover.tsx`
- Modify: `components/user-menu.tsx`, `components/app-sidebar.tsx` (user prop), `app/[locale]/layout.tsx` (pass status, image)

**Interfaces:**
- Consumes:
  - `setStatus`, `clearStatus` (Task 4)
  - `activeStatus` (Task 1)
  - `UserAvatar` (Task 7)
  - `effectiveTimeZone` (Task 2)
- Produces:
  - `UserSummary` in `user-menu.tsx` gains `status: { emoji: string | null; text: string | null; expiresAt: string | null } | null` and `timeZone: string`
  - `expiryFromPreset(preset: StatusPreset, now: Date, timeZone: string): Date | null`, exported from `lib/user-display.ts` with tests

- [ ] **Step 1: Test the expiry presets (append to `tests/user-display.test.ts`)**

```ts
import { expiryFromPreset } from "@/lib/user-display";

describe("expiryFromPreset", () => {
  const now = new Date("2026-10-09T03:00:00Z"); // Fri 10:00 WIB
  it("adds durations", () => {
    expect(expiryFromPreset("30m", now, "Asia/Jakarta")?.toISOString()).toBe("2026-10-09T03:30:00.000Z");
    expect(expiryFromPreset("4h", now, "Asia/Jakarta")?.toISOString()).toBe("2026-10-09T07:00:00.000Z");
  });
  it("ends today at local midnight", () => {
    expect(expiryFromPreset("today", now, "Asia/Jakarta")?.toISOString()).toBe("2026-10-09T17:00:00.000Z");
  });
  it("ends the week at local Monday 00:00", () => {
    expect(expiryFromPreset("week", now, "Asia/Jakarta")?.toISOString()).toBe("2026-10-11T17:00:00.000Z");
  });
  it("never", () => {
    expect(expiryFromPreset("never", now, "Asia/Jakarta")).toBeNull();
  });
});
```

Run: `bun test tests/user-display.test.ts`
Expected: FAIL (`expiryFromPreset` missing).

- [ ] **Step 2: Implement in `lib/user-display.ts`**

```ts
export type StatusPreset = "30m" | "1h" | "4h" | "today" | "week" | "never";

// UTC instant of local midnight `daysAhead` days after `now`'s local date.
function localMidnight(now: Date, timeZone: string, daysAhead: number): Date {
  const { minutes } = zonedClock(timeZone, now);
  const offsetMs = (() => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((x) => x.type === "timeZoneName")?.value ?? "GMT";
    const m = p.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
  })();
  const localNow = now.getTime() + offsetMs;
  const startOfLocalDay = localNow - (minutes * 60_000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
  return new Date(startOfLocalDay + daysAhead * 86_400_000 - offsetMs);
}

export function expiryFromPreset(preset: StatusPreset, now: Date, timeZone: string): Date | null {
  switch (preset) {
    case "30m": return new Date(now.getTime() + 30 * 60_000);
    case "1h": return new Date(now.getTime() + 60 * 60_000);
    case "4h": return new Date(now.getTime() + 4 * 60 * 60_000);
    case "today": return localMidnight(now, timeZone, 1);
    case "week": {
      const { weekday } = zonedClock(timeZone, now);
      return localMidnight(now, timeZone, 8 - weekday); // next Monday 00:00
    }
    case "never": return null;
  }
}
```

The offset is taken at `now`. A DST jump before midnight shifts the expiry by up to one hour, which is acceptable for a status.

Run: `bun test tests/user-display.test.ts`
Expected: PASS.

- [ ] **Step 3: `components/user/status-popover.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { clearStatus, setStatus } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import { expiryFromPreset, type StatusPreset } from "@/lib/user-display";
import { PROFILE_LIMITS } from "@/lib/validation";

const SUGGESTIONS = [
  { emoji: "🎯", key: "focus", preset: "1h" },
  { emoji: "🗓️", key: "meeting", preset: "1h" },
  { emoji: "🤒", key: "sick", preset: "today" },
  { emoji: "🌴", key: "leave", preset: "week" },
  { emoji: "🏠", key: "wfh", preset: "today" },
] as const;
const QUICK_EMOJI = ["🎯", "🗓️", "🤒", "🌴", "🏠", "🚗", "🍽️", "🔧", "🚀", "☕"];
const PRESETS: StatusPreset[] = ["30m", "1h", "4h", "today", "week", "never"];

/** Controlled dialog for setting the caller's status. Opened from the user menu. */
export function StatusDialog({
  open,
  onOpenChange,
  current,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: { emoji: string | null; text: string | null } | null;
  timeZone: string;
}) {
  const t = useTranslations("status");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [emoji, setEmoji] = useState(current?.emoji ?? "💬");
  const [text, setText] = useState(current?.text ?? "");
  const [preset, setPreset] = useState<StatusPreset>("today");

  const run = (fn: () => Promise<{ success: boolean; message?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.success) return void toast.error(res.message);
      onOpenChange(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("title")}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input aria-label={t("emoji")} value={emoji} onChange={(e) => setEmoji(e.target.value)} className="w-14 text-center text-lg" />
            <Input aria-label={t("text")} placeholder={t("placeholder")} value={text} maxLength={PROFILE_LIMITS.statusText} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-1">
            {QUICK_EMOJI.map((e) => (
              <Button key={e} type="button" size="icon" variant="ghost" aria-label={e} onClick={() => setEmoji(e)}>{e}</Button>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {SUGGESTIONS.map((s) => (
              <Button key={s.key} type="button" variant="ghost" className="justify-start"
                onClick={() => { setEmoji(s.emoji); setText(t(`suggestions.${s.key}`)); setPreset(s.preset); }}>
                {s.emoji} {t(`suggestions.${s.key}`)} <span className="ms-auto text-xs text-muted-foreground">{t(`presets.${s.preset}`)}</span>
              </Button>
            ))}
          </div>
          <Select value={preset} onValueChange={(v) => setPreset(v as StatusPreset)}>
            <SelectTrigger aria-label={t("clearAfter")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => <SelectItem key={p} value={p}>{t(`presets.${p}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          {current && <Button variant="ghost" disabled={pending} onClick={() => run(clearStatus)}>{t("clear")}</Button>}
          <Button disabled={pending} onClick={() => run(() => setStatus({
            emoji: emoji.trim() || null,
            text: text,
            expiresAt: expiryFromPreset(preset, new Date(), timeZone)?.toISOString() ?? null,
          }))}>{t("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

i18n `status` namespace (5 locales):
- `title`: "Set a status"
- `emoji`: "Emoji"
- `text`: "Status"
- `placeholder`: "What's your status?"
- `clearAfter`: "Clear after"
- `clear`: "Clear status"
- `save`: "Save"
- `set`: "Set status"
- `presets`:
  - `30m`: "30 minutes"
  - `1h`: "1 hour"
  - `4h`: "4 hours"
  - `today`: "Today"
  - `week`: "This week"
  - `never`: "Don't clear"
- `suggestions`:
  - `focus`: "Focusing"
  - `meeting`: "In a meeting"
  - `sick`: "Out sick"
  - `leave`: "On leave"
  - `wfh`: "Working from home"

The spec's "picked date" preset is dropped as YAGNI. The week preset covers leave, and the status can be cleared by hand. Note this in the PR description.

- [ ] **Step 4: User menu**

In `components/user-menu.tsx`:
- Extend `UserSummary` with `image: string | null`, `status`, and `timeZone`.
- Replace both initials spans with `<UserAvatar user={user} size="md" className={variant === "sidebar" ? "rounded-md" : undefined} />`. Remove the `initials` computation and the `initials` prop of `SidebarUserTrigger`.
- Under the name in `DropdownMenuLabel`, show `{user.status && <span className="text-xs">{user.status.emoji} {user.status.text}</span>}`.
- After the label separator, add:

```tsx
        <DropdownMenuItem onClick={() => router.push(`/people/${user.id}`)}>
          <IdCard />
          {t("myProfile")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setStatusOpen(true)}>
          <Smile />
          {user.status ? t("editStatus") : t("setStatus")}
        </DropdownMenuItem>
```

- Render `<StatusDialog open={statusOpen} onOpenChange={setStatusOpen} current={user.status} timeZone={user.timeZone} />` next to the `DropdownMenu`, wrapping both in a fragment, with `const [statusOpen, setStatusOpen] = React.useState(false);`.

i18n `userMenu` (5 locales):
- `myProfile`: "My profile"
- `setStatus`: "Set status"
- `editStatus`: "Edit status"

In `app/[locale]/layout.tsx`, where `AppSidebar` gets `user={{…}}`, add:

```tsx
                          status: (() => {
                            const s = activeStatus(session.user);
                            return s && { ...s, expiresAt: s.expiresAt?.toISOString() ?? null };
                          })(),
                          timeZone: effectiveTimeZone(session.user),
```

Thread the widened type through `components/app-sidebar.tsx`'s `user` prop type into `UserMenu`.

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run lint && bun test`.

In dev:
- Set "🌴 On leave · This week". The menu shows it.
- Set "30 minutes", then `UPDATE users SET status_expires_at = now() - interval '1 second'` and reload. The status is gone.

- [ ] **Step 6: Commit**

```bash
git add lib/user-display.ts tests/user-display.test.ts components/user/status-popover.tsx components/user-menu.tsx components/app-sidebar.tsx app/[locale]/layout.tsx messages
git commit -m "feat(profile): status with expiry presets and user-menu avatar"
```

---

### Task 11: People directory, profile page, nav and the assignee filter

**Files:**
- Create: `lib/people/queries.ts`, `app/[locale]/people/page.tsx`, `app/[locale]/people/people-client.tsx`, `app/[locale]/people/[id]/page.tsx`, `app/[locale]/people/[id]/loading.tsx`
- Modify:
  - `tests/authz-guards.test.ts`
  - `components/app-sidebar.tsx`, `components/command-palette.tsx`
  - `lib/issue-query.ts`, `app/[locale]/issues/page.tsx`, `components/issues-filter-bar.tsx`
  - `messages/*.json`

**Interfaces:**
- Consumes:
  - `getUserCard` (Task 7)
  - `UserAvatar`, `UserName`, `LocalTime`, `teamsChatUrl` (Task 7)
  - `activeStatus`, `isWithinWorkingHours` (Task 1)
  - `projectScope`, `projectIdsWhere`, `getProjectAccess` (`lib/authz.ts`)
  - `effectiveProjectRole`, `canOrg` (`lib/permissions.ts`)
- Produces:
  - `listPeople(viewerRole: string | null | undefined): Promise<PersonSummary[]>`
  - `getPersonProjects(userId: string): Promise<{ id: string; key: string; name: string; role: ProjectRole }[]>`
  - `listPersonOpenIssues(userId: string, limit?: number): Promise<{ items: PersonIssue[]; total: number }>`
  - `listPersonRecentRuns(userId: string, limit?: number): Promise<PersonRun[]>`
  - `getPersonMeta(userId: string): Promise<{ createdAt: Date; lastActiveAt: Date | null }>`
  - URL `/issues?assignee=<uuid>`

- [ ] **Step 1: Write the failing structural test**

In `tests/authz-guards.test.ts`, add to `SCOPED_READS`:

```ts
  "lib/people/queries.ts": [
    "listPeople",
    "getPersonProjects",
    "listPersonOpenIssues",
    "listPersonRecentRuns",
  ],
```

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL (`ENOENT lib/people/queries.ts`).

- [ ] **Step 2: Write `lib/people/queries.ts`**

```ts
import "server-only";

import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { getProjectAccess, projectIdsWhere, projectScope } from "@/lib/authz";
import { db } from "@/lib/db";
import { issues, projectMembers, projects, sessions, users } from "@/lib/db/schema";
import { canOrg, effectiveProjectRole, type ProjectRole } from "@/lib/permissions";
import { effectiveTimeZone } from "@/lib/timezone";
import { activeStatus, type WorkingHours } from "@/lib/user-display";

// Reads about OTHER users. Profile fields are public to signed-in users;
// anything carrying a project (memberships, issues, runs) is filtered to the
// VIEWER's projects, so a profile never reveals a project the viewer can't open.

export type PersonSummary = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  title: string | null;
  role: string;
  timeZone: string;
  workingHours: WorkingHours | null;
  status: { emoji: string | null; text: string | null; expiresAt: string | null } | null;
  lastActiveAt: string | null;
  /** Viewer-visible projects this person can also see. */
  projectIds: string[];
  deactivated: boolean;
};

export async function listPeople(viewerRole: string | null | undefined): Promise<PersonSummary[]> {
  const access = await getProjectAccess();
  const visible = Object.keys(access.roles);
  const includeBanned = canOrg(viewerRole, { user: ["list"] });

  const [rows, memberships] = await Promise.all([
    db
      .select({
        id: users.id, name: users.name, email: users.email, image: users.image,
        title: users.title, role: users.role, timezone: users.timezone,
        workingHours: users.workingHours, banned: users.banned,
        statusEmoji: users.statusEmoji, statusText: users.statusText,
        statusExpiresAt: users.statusExpiresAt,
        lastActiveAt: max(sessions.updatedAt),
      })
      .from(users)
      .leftJoin(sessions, eq(sessions.userId, users.id))
      .where(includeBanned ? undefined : eq(users.banned, false))
      .groupBy(users.id)
      .orderBy(sql`lower(${users.name})`),
    visible.length
      ? db
          .select({ userId: projectMembers.userId, projectId: projectMembers.projectId, role: projectMembers.role })
          .from(projectMembers)
          .where(inArray(projectMembers.projectId, visible))
      : Promise.resolve([]),
  ]);

  const byUser = new Map<string, Map<string, string>>();
  for (const m of memberships) {
    if (!byUser.has(m.userId)) byUser.set(m.userId, new Map());
    byUser.get(m.userId)?.set(m.projectId, m.role);
  }

  return rows.map((u) => {
    const mine = byUser.get(u.id);
    const projectIds = visible.filter((pid) => effectiveProjectRole(u.role, mine?.get(pid)) !== null);
    const status = activeStatus(u);
    return {
      id: u.id, name: u.name, email: u.email, image: u.image, title: u.title, role: u.role,
      timeZone: effectiveTimeZone(u),
      workingHours: u.workingHours ?? null,
      status: status && { ...status, expiresAt: status.expiresAt?.toISOString() ?? null },
      lastActiveAt: u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : null,
      projectIds,
      deactivated: u.banned,
    };
  });
}

export async function getPersonProjects(
  userId: string
): Promise<{ id: string; key: string; name: string; role: ProjectRole }[]> {
  const access = await getProjectAccess();
  const [target, memberships, visibleProjects] = await Promise.all([
    db.query.users.findFirst({ where: { id: userId }, columns: { role: true } }),
    db.select({ projectId: projectMembers.projectId, role: projectMembers.role })
      .from(projectMembers).where(eq(projectMembers.userId, userId)),
    db.select({ id: projects.id, key: projects.key, name: projects.name })
      .from(projects).where(await projectScope(projects.id)).orderBy(projects.name),
  ]);
  if (!target) return [];
  const membership = new Map(memberships.map((m) => [m.projectId, m.role]));
  return visibleProjects.flatMap((p) => {
    if (!access.roles[p.id]) return [];
    const role = effectiveProjectRole(target.role, membership.get(p.id));
    return role ? [{ ...p, role }] : [];
  });
}

export type PersonIssue = {
  id: string; number: number; title: string; status: string; projectKey: string;
};

export async function listPersonOpenIssues(
  userId: string,
  limit = 20
): Promise<{ items: PersonIssue[]; total: number }> {
  const where = and(
    eq(issues.assigneeId, userId),
    inArray(issues.status, ["open", "in_progress"]),
    await projectScope(issues.projectId)
  );
  const [items, [totalRow]] = await Promise.all([
    db.select({
        id: issues.id, number: issues.number, title: issues.title,
        status: issues.status, projectKey: projects.key,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(where)
      .orderBy(sql`${issues.status} = 'in_progress' desc`, desc(issues.updatedAt))
      .limit(limit),
    db.select({ total: count() }).from(issues).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export type PersonRun = {
  id: string; description: string; status: string; kind: string | null; runAt: Date;
  environment: { name: string; slug: string; project: { key: string } };
};

export async function listPersonRecentRuns(userId: string, limit = 10): Promise<PersonRun[]> {
  const projectIds = await projectIdsWhere();
  const rows = await db.query.runs.findMany({
    where: { userId, ...(projectIds && { environment: { projectId: projectIds } }) },
    columns: { id: true, description: true, status: true, kind: true, runAt: true },
    with: {
      environment: {
        columns: { name: true, slug: true },
        with: { project: { columns: { key: true } } },
      },
    },
    orderBy: { runAt: "desc" },
    limit,
  });
  return rows as PersonRun[];
}

/** No project data, so not in SCOPED_READS. */
export async function getPersonMeta(userId: string) {
  const [row] = await db
    .select({ createdAt: users.createdAt, lastActiveAt: max(sessions.updatedAt) })
    .from(users)
    .leftJoin(sessions, eq(sessions.userId, users.id))
    .where(eq(users.id, userId))
    .groupBy(users.id);
  return { createdAt: row?.createdAt ?? new Date(0), lastActiveAt: row?.lastActiveAt ?? null };
}
```

Run: `bun test tests/authz-guards.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Directory `app/[locale]/people/page.tsx` and `people-client.tsx`**

```tsx
// page.tsx
import { getTranslations, setRequestLocale } from "next-intl/server";
import { listProjects } from "@/actions/project-catalog";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";
import { listPeople } from "@/lib/people/queries";
import { PeopleClient } from "./people-client";

export default async function PeoplePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();
  const [people, projects, t] = await Promise.all([
    listPeople(session.user.role),
    listProjects(),
    getTranslations("people"),
  ]);
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <PeopleClient people={people} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
    </>
  );
}
```

```tsx
// people-client.tsx
"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LocalTime } from "@/components/user/local-time";
import { UserAvatar } from "@/components/user/user-avatar";
import { Link } from "@/i18n/navigation";
import type { PersonSummary } from "@/lib/people/queries";
import { ORG_ROLES } from "@/lib/permissions";

const ALL = "__all";

export function PeopleClient({ people, projects }: { people: PersonSummary[]; projects: { id: string; name: string }[] }) {
  const t = useTranslations("people");
  const tRole = useTranslations("users.role");
  const [q, setQ] = useState("");
  const [role, setRole] = useState(ALL);
  const [project, setProject] = useState(ALL);

  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return people.filter(
      (p) =>
        (!needle || [p.name, p.title ?? "", p.email].some((s) => s.toLocaleLowerCase().includes(needle))) &&
        (role === ALL || p.role === role) &&
        (project === ALL || p.projectIds.includes(project))
    );
  }, [people, q, role, project]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder={t("search")} aria-label={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={role} onValueChange={(v) => setRole(v ?? ALL)}>
          <SelectTrigger className="w-40" aria-label={t("filterRole")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allRoles")}</SelectItem>
            {ORG_ROLES.map((r) => <SelectItem key={r} value={r}>{tRole(r)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={project} onValueChange={(v) => setProject(v ?? ALL)}>
          <SelectTrigger className="w-48" aria-label={t("filterProject")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allProjects")}</SelectItem>
            {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {shown.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => (
            <li key={p.id}>
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardContent className="flex items-start gap-3">
                  <UserAvatar user={p} size="lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Link href={`/people/${p.id}`} className="truncate font-medium after:absolute after:inset-0 relative">
                      {p.name}
                    </Link>
                    {p.title && <span className="truncate text-sm text-muted-foreground">{p.title}</span>}
                    {p.status && <span className="truncate text-sm">{p.status.emoji} {p.status.text}</span>}
                    <span className="text-xs"><LocalTime timeZone={p.timeZone} workingHours={p.workingHours} /></span>
                    {p.deactivated && <Badge variant="secondary" className="w-fit">{t("deactivated")}</Badge>}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Check `EmptyState`'s props in `components/ui/empty-state.tsx` and match them. Put `relative` on the `Card` rather than the link if the stretched link's overlay misaligns.

- [ ] **Step 4: Profile page `app/[locale]/people/[id]/page.tsx`**

```tsx
import { formatDistanceToNow } from "date-fns";
import { Mail, MessageSquare, Pencil, Settings, SquareArrowOutUpRight } from "lucide-react";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalTime } from "@/components/user/local-time";
import { UserAvatar } from "@/components/user/user-avatar";
import { teamsChatUrl } from "@/components/user/user-card";
import { Link } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { getUserCard } from "@/lib/people/card";
import { getPersonMeta, getPersonProjects, listPersonOpenIssues, listPersonRecentRuns } from "@/lib/people/queries";
import { canOrg } from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";

export default async function PersonPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = await requireSession();
  const card = await getUserCard(id, session.user);
  if (!card) notFound();

  const [projects, openIssues, runs, meta, t, tRole, tProject, tIssues, format] = await Promise.all([
    getPersonProjects(id),
    listPersonOpenIssues(id),
    listPersonRecentRuns(id),
    getPersonMeta(id),
    getTranslations("people"),
    getTranslations("users.role"),
    getTranslations("projectMembers.role"),
    getTranslations("issues"),
    getFormatter(),
  ]);
  const dfLocale = getDateFnsLocale(await getLocale());
  const isMe = session.user.id === id;
  const canManage = canOrg(session.user.role, { user: ["update"] });

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader title={card.name} subtitle={card.title ?? undefined} />
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <UserAvatar user={card} size="xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{tRole(card.role)}</Badge>
              {card.deactivated && <Badge variant="secondary">{t("deactivated")}</Badge>}
            </div>
            {card.status && (
              <p>
                {card.status.emoji} {card.status.text}
                {card.status.expiresAt && (
                  <span className="text-muted-foreground"> · {t("until", { date: format.dateTime(new Date(card.status.expiresAt), { dateStyle: "medium", timeStyle: "short" }) })}</span>
                )}
              </p>
            )}
            <p className="text-sm"><LocalTime timeZone={card.timeZone} workingHours={card.workingHours} /></p>
            {card.bio && <p className="whitespace-pre-line text-sm">{card.bio}</p>}
            <p className="text-xs text-muted-foreground">
              {t("memberSince", { date: format.dateTime(meta.createdAt, { dateStyle: "medium" }) })}
              {" · "}
              {meta.lastActiveAt
                ? t("lastActive", { ago: formatDistanceToNow(meta.lastActiveAt, { addSuffix: true, locale: dfLocale }) })
                : t("neverActive")}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" render={<a href={`mailto:${card.email}`} />}><Mail />{card.email}</Button>
              <Button size="sm" variant="outline" render={<a href={teamsChatUrl(card.email)} target="_blank" rel="noreferrer" />}><MessageSquare />{t("teams")}</Button>
              {card.jiraUrl && (
                <Button size="sm" variant="outline" render={<a href={card.jiraUrl} target="_blank" rel="noreferrer" />}><SquareArrowOutUpRight />{t("jira")}</Button>
              )}
              {isMe && <Button size="sm" render={<Link href="/account?tab=profile" />}><Pencil />{t("editProfile")}</Button>}
              {canManage && !isMe && <Button size="sm" variant="ghost" render={<Link href="/admin/users" />}><Settings />{t("manage")}</Button>}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("projects")}</CardTitle></CardHeader>
          <CardContent>
            {projects.length === 0 ? <p className="text-sm text-muted-foreground">{t("noSharedProjects")}</p> : (
              <ul className="flex flex-col gap-2">
                {projects.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <Link href={`/${p.key}`} className="truncate hover:underline">{p.name}</Link>
                    <Badge variant="outline">{tProject(p.role)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("openIssues", { count: openIssues.total })}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {openIssues.items.length === 0 ? <p className="text-sm text-muted-foreground">{t("noOpenIssues")}</p> : (
              <ul className="flex flex-col gap-2">
                {openIssues.items.map((i) => (
                  <li key={i.id} className="flex items-center gap-2 text-sm">
                    <Link href={`/${i.projectKey}/issues/${i.number}`} className="font-mono text-muted-foreground hover:underline">{i.projectKey}-{i.number}</Link>
                    <span className="truncate">{i.title}</span>
                    <Badge variant="secondary" className="ms-auto shrink-0">{tIssues(`status.${i.status}`)}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {openIssues.total > openIssues.items.length && (
              <Link href={`/issues?assignee=${id}`} className="text-sm underline underline-offset-2">{t("viewAllIssues")}</Link>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>{t("recentRuns")}</CardTitle></CardHeader>
        <CardContent>
          {runs.length === 0 ? <p className="text-sm text-muted-foreground">{t("noRuns")}</p> : (
            <ul className="flex flex-col gap-2 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
                  <Link href={`/${r.environment.project.key}/${r.environment.slug}/history`} className="truncate hover:underline">
                    {r.environment.name} · {r.description}
                  </Link>
                  <span className="ms-auto shrink-0 text-muted-foreground">
                    {formatDistanceToNow(r.runAt, { addSuffix: true, locale: dfLocale })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

Before relying on them, check a few things and adapt the code:
- **Project-role labels** come from the existing `projectMembers.role.<role>` keys.
- **Run-status labels.** Reuse the history page's existing translations (see `history-client.tsx`) instead of the raw `r.status`.
- **Issue and history URLs.** Confirm `/${key}/issues/${number}` and `/${key}/${slug}/history` against the `app/[locale]/[projectKey]` folder tree.

`loading.tsx`: copy an existing `loading.tsx` (e.g. `app/[locale]/admin/activity/loading.tsx`) and adapt its skeleton.

i18n `people` (5 locales):
- `title`: "People"
- `subtitle`: "Everyone in {{APP_NAME}}."
- `search`: "Search by name, title or email"
- `filterRole`: "Role"
- `filterProject`: "Project"
- `allRoles`: "All roles"
- `allProjects`: "All projects"
- `empty`: "No one matches these filters."
- `memberSince`: "Member since {date}"
- `lastActive`: "Active {ago}"
- `neverActive`: "Never signed in"
- `jira`: "Jira profile"
- `editProfile`: "Edit profile"
- `manage`: "Manage"
- `projects`: "Projects"
- `noSharedProjects`: "No projects you can see."
- `openIssues`: "Open issues ({count})"
- `noOpenIssues`: "No open issues assigned."
- `viewAllIssues`: "View all"
- `recentRuns`: "Recent runs"
- `noRuns`: "No runs you can see."

- [ ] **Step 5: Entry points**

**Sidebar.** In `components/app-sidebar.tsx`, add a `People` item directly after Knowledge, the same shape as the Knowledge item:

```tsx
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/people" />}
                  isActive={pathname.startsWith("/people")}
                  tooltip={tNav("people")}
                >
                  <UsersRound />
                  <span>{tNav("people")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
```

**Command palette.** In `components/command-palette.tsx`, add after the Knowledge item:

```tsx
            <CommandItem value="people team directory profiles" onSelect={() => run(() => router.push("/people"))}>
              <UsersRound />
              {tNav("people")}
            </CommandItem>
```

**i18n.** `nav.people`: "People" (5 locales).

**Breadcrumb.** Check that `components/header-breadcrumb.tsx` renders top-level static segments from a map. If so, add `people` there with `nav.people`.

- [ ] **Step 6: `assignee` filter on `/issues`**

- In `lib/issue-query.ts`, add `"assignee"` to `ISSUE_FILTER_KEYS` after `"mine"`.
- In `app/[locale]/issues/page.tsx`, use `assigneeId: filters.mine === "1" ? session.user.id : filters.assignee`. `listAllIssues` already ignores a non-uuid value through `isUuid`.
- In `components/issues-filter-bar.tsx`, next to the `mine` chip (line 120), add a chip for `filters.assignee` whose value is the matching user's name from the `users` prop. If the bar doesn't receive `users`, pass it down from `GlobalIssuesClient`, which already has it. Removing the chip clears `assignee`.

Add `tests/issue-query.test.ts` case:

```ts
it("keeps the assignee filter", () => {
  const id = "0199a1b2-0000-7000-8000-000000000001";
  expect(parseIssueParams({ assignee: id }).filters.assignee).toBe(id);
});
```

- [ ] **Step 7: Verify**

Run: `bun run typecheck && bun run lint && bun test`.

In dev:
- `/people` lists users, and search, role and project filters work.
- `/people/<id>` renders. "View all" opens `/issues?assignee=…`, filtered, with a chip.
- `/people/not-a-uuid` gives 404.

- [ ] **Step 8: Commit**

```bash
git add lib/people/queries.ts app/[locale]/people components/app-sidebar.tsx components/command-palette.tsx components/header-breadcrumb.tsx lib/issue-query.ts app/[locale]/issues/page.tsx components/issues-filter-bar.tsx components/global-issues-client.tsx tests messages
git commit -m "feat(people): directory, profile page and assignee filter"
```

---

### Task 12: Render users through `UserName`, part 1: issues

**Files (modify):**
- `actions/issues.ts`: the `assignee`/`createdBy` relation columns at lines ~289 and ~669, the `assigneeName` select at ~523/552, and comment authors in `getIssueDetail`
- `actions/users.ts` `listAssignableUsersAcrossProjects`, plus the per-project assignable-users query (grep `assignableUsersWhere(` in `actions/`)
- `components/issues-board.tsx` (`AssignableUser` type ~199, `AssigneeSelect` ~205, card assignee ~321)
- `components/global-issues-client.tsx` (~346, ~473)
- `app/[locale]/[projectKey]/[envSlug]/issues/issues-client.tsx` (~381)
- `app/[locale]/[projectKey]/issues/[number]/issue-detail-client.tsx` (~501, comment author)
- `app/[locale]/[projectKey]/issues/[number]/page.tsx` (~75, "Created by")
- `components/mention-textarea.tsx` (~112, suggestion rows)

**Interfaces:**
- Consumes: `UserRef`, `UserName`, `UserAvatar` (Task 7); `activeStatus` (Task 1).
- Produces:
  - Every issue-side user object is `UserRef` (`{ id, name, image }`).
  - Assignable users are `UserRef & { status: { emoji: string | null; text: string | null } | null }`.

- [ ] **Step 1: Widen the queries**

Do this mechanically:
- Every `columns: { id: true, name: true }` on a `users` relation becomes `columns: { id: true, name: true, image: true }`.
- In `listAllIssues`, add `assigneeImage: assigneeUser.image` to the select. Map the result to `assignee: r.issue.assigneeId ? { id: r.issue.assigneeId, name: r.assigneeName ?? "", image: r.assigneeImage ?? null } : null`.
- Update the exported row types, e.g. `assignee: { id: string; name: string } | null` → `assignee: UserRef | null` at lines ~164 and ~261.

Assignable-user queries select status too, then map:

```ts
  const rows = await db
    .select({
      id: userTable.id, name: userTable.name, image: userTable.image,
      statusEmoji: userTable.statusEmoji, statusText: userTable.statusText, statusExpiresAt: userTable.statusExpiresAt,
    })
    .from(userTable)
    .where(assignableUsersWhere(await projectScope(projectMembers.projectId)))
    .orderBy(userTable.name);
  return rows.map(({ statusEmoji, statusText, statusExpiresAt, ...u }) => {
    const s = activeStatus({ statusEmoji, statusText, statusExpiresAt });
    return { ...u, status: s && { emoji: s.emoji, text: s.text } };
  });
```

Run: `bun run typecheck`. The errors now list every consumer still on the old shape. Fix them in Steps 2–3.

- [ ] **Step 2: Swap the renders**

- Board card assignee (`issues-board.tsx` ~321): replace the name text with `<UserName user={issue.assignee} avatar />`, where `issue.assignee` is a `UserRef | null`. Keep "Unassigned" text when null; do not render "Deleted user" for unassigned.
- Global and environment issue tables: in the assignee column cell, render `row.original.assignee ? <UserName user={row.original.assignee} avatar /> : <span className="text-muted-foreground">{t("unassigned")}</span>`.
- Issue detail: in the comment author header, replace the first-letter circle and name with `<UserAvatar user={c.author} size="md" />` followed by `<UserName user={c.author} />`. A comment whose author was deleted has `author === null`, and `UserName` renders "Deleted user".
- Issue page subtitle "Created by {name}": the subtitle is a string prop, so keep the string. Add a `UserName` for the creator in the detail client's metadata panel next to "Created by", if one exists. Otherwise leave the subtitle text as is.
- `AssigneeSelect`: in each `SelectItem`, render:

```tsx
            <span className="flex items-center gap-2">
              <UserAvatar user={u} size="xs" />
              <span className="truncate">{u.name}</span>
              {u.status?.emoji && <span title={u.status.text ?? undefined}>{u.status.emoji}</span>}
            </span>
```

  Update `type AssignableUser = UserRef & { status?: { emoji: string | null; text: string | null } | null }`.
- Mention suggestions: prefix each row with `<UserAvatar user={u} size="xs" />`. Widen its user source to include `image`, which is the same assignable/visible users query.

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun run lint && bun test`.

In dev:
- The board, the global list and the env list show avatars and names.
- Hovering an assignee opens the card, and clicking goes to `/people/<id>`.
- The assignee picker shows 🌴 for a user with a status.
- Comments show avatars.

- [ ] **Step 4: Commit**

```bash
git add actions/issues.ts actions/users.ts components/issues-board.tsx components/global-issues-client.tsx app/[locale]/[projectKey] components/mention-textarea.tsx
git commit -m "feat(people): avatars and hover cards across issues"
```

---

### Task 13: Render users through `UserName`, part 2: runs, activity, knowledge, admin

**Files (modify):**
- `actions/runs.ts` (`getEnvironmentRuns` user columns ~113, and the recent-activity query feeding `recent-activity.tsx`)
- `app/[locale]/[projectKey]/[envSlug]/history/history-client.tsx` (~64-71)
- `app/[locale]/[projectKey]/[envSlug]/recent-activity.tsx` (~84)
- `actions/activity.ts` (`listActivity`), `app/[locale]/admin/activity/page.tsx`
- `app/[locale]/knowledge/[slug]/page.tsx` (~79), `components/knowledge-history-client.tsx` (~75), and their queries in `actions/knowledge*.ts` (grep `name: true` near `editor`/`updatedBy`)
- `app/[locale]/admin/access/access-client.tsx` (~166) and `actions/access.ts` `getAccessMatrix`
- `app/[locale]/[projectKey]/project-members-client.tsx` (~82, ~140) and `actions/project-members.ts`
- `app/[locale]/admin/users/users-client.tsx` (~500-505, ~602)

**Interfaces:**
- Consumes: `UserRef`, `UserName`, `UserAvatar` (Task 7).

- [ ] **Step 1: Widen the queries**

The rule is the same as in Task 12: every users relation/select that feeds a rendered name adds `image` and keeps `id`.
- `listActivity`: add `actorId: activityLog.actorId` and `actorImage: users.image` to the select, and to `ActivityRow` as `actorId: string | null; actorImage: string | null`.
- `getAccessMatrix`: add `image: users.image` to its user select.
- `project-members`: add `image`.

Run: `bun run typecheck` and fix every reported consumer.

- [ ] **Step 2: Swap the renders**

- History "triggered by" (`history-client.tsx`): `run.user ? <UserName user={run.user} avatar /> : t("unknownUser")`. Remove the `title={email}` that the card now replaces.
- `recent-activity.tsx`: `· <UserName user={run.user} />`.
- `/admin/activity`: the sentence is one ICU string with `{actor}`. Keep the sentence text, and add `<UserAvatar user={{ id: row.actorId, name: row.actorName, image: row.actorImage }} size="sm" />` at the start of each row when `actorId` is set. A rich-text `t.rich` actor link would mean changing 30+ templates, so it is out of scope.
- Knowledge page editor line and revision list: `<UserName user={doc.updatedBy} />`.
- Access matrix user cell and project members rows: `<UserName user={u} avatar="md" />`.
- Admin users list: replace the size-9 initials circles with `<UserAvatar user={u} size="md" />` and make the name a `UserName`. Delete the local `getInitials` if Task 1 left an import unused.

- [ ] **Step 3: Sweep for leftovers**

Run: `grep -rnE "\.name\}|user\.name|actorName|assigneeName" app components --include=*.tsx | grep -v "components/user/"`

Every remaining hit must be one of these:
- a non-user name (project, environment, server)
- a plain-string context (an `aria-label`, an i18n param, the greeting `firstName`)
- the user menu's own label

Convert anything else.

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun test`.

In dev, open history, an environment page, `/admin/activity`, a knowledge doc and its history, `/admin/access`, project members and `/admin/users`. Each should show avatars, and names should open cards.

- [ ] **Step 5: Commit**

```bash
git add actions app components
git commit -m "feat(people): avatars and hover cards across runs, knowledge and admin"
```

---

### Task 14: Final verification and deploy notes

**Files:**
- Modify: `README.md` (short "User profiles" note under the object-storage section: avatars share the bucket under `avatars/`)
- Modify: `docs/microsoft-sign-in.md` (photo import; fix the stale `lib/roles.ts`/`viewer` references to `lib/permissions.ts`/`member`)

- [ ] **Step 1: Full suite**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all green. Paste the summary lines into the PR description.

- [ ] **Step 2: Manual browser checks**

Use the `run` skill or `bun run dev`. Record the result of each check in the PR description.

- **M1. Avatar.** Upload a JPEG, crop it, and save. Then remove it. Then click "Use Microsoft photo" as a Microsoft-linked user.
- **M2. Hover card.** Hover a name with the mouse. Tab to a name and check the card opens on focus and Escape closes it. Narrow the viewport to mobile emulation and check that a tap navigates.
- **M3. Scoping.** Sign in as a `member` with no shared project, open the profile of an `infra` user, and check that Projects, Open issues and Recent runs are empty. Then open `/api/users/<id>/card` and confirm the JSON has no project fields.
- **M4. Timezone.** Set `America/New_York`. Issue timestamps move, the server clock doesn't, and the tz hint stops showing.
- **M5. Stale avatar.** Upload avatar A, copy its `/api/avatars/...` URL, upload B, then request A's URL. It returns 404, and an `<img>` pointing at it would fall back to initials.
- **M6. RTL.** Switch to `ar`. The card, profile and directory mirror correctly.
- **M7. Dark mode.** The initials colours stay readable.
- **M8. Name clash.** Invite a new user whose name equals an existing user's, and accept. The account is created as "Name (local-part)".

- [ ] **Step 3: Docs**

Update `README.md` and `docs/microsoft-sign-in.md` as listed above. Commit:

```bash
git add README.md docs/microsoft-sign-in.md
git commit -m "docs: user profiles and Microsoft photo import"
```

- [ ] **Step 4: Deploy checklist (for the PR description, not executed here)**

1. Back up the live DB (the established VPN + SSH procedure).
2. Run the pre-flight queries from the migration header. Both must return zero rows. Rename any duplicates by hand first.
3. Apply `drizzle/20261009000000_user_profile/migration.sql`.
4. Deploy the build. No env or compose changes are needed.
