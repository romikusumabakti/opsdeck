# User profiles — design

Date: 2026-10-09
Status: approved (brainstorming), pending spec review

## Goal

Give every user a recognisable identity across OpsDeck: a self-managed display name, avatar, job title, short bio, timezone, working hours and status. Show it on a profile page, in a people directory, and in a hover card wherever a user's name appears, so a teammate can tell at a glance who someone is, what they do, and whether now is a good time to reach them.

## Problems with the current state

- **Thin identity.** `users` (`lib/db/schema.ts`) carries only `name`, `email` and an `image` column that nothing fills. Microsoft sign-in sets `disableProfilePhoto: true`, so every user is an initials circle.
- **Name is admin-only.** Only `updateUserName` (`user:update`) can rename a user. The account page says "name managed by admin".
- **Duplicated rendering.** Initials logic is copied in `user-menu.tsx`, `account/profile-card.tsx` and `admin/users/users-client.tsx`. About 15 other places render a bare name string. There is no shared avatar or name component and no hover card primitive.
- **One timezone for everyone.** All dates render in `APP_TIMEZONE`, whatever zone the reader is in.
- **No way to find people.** There is no profile page and no directory. A name in an issue or a run history leads nowhere.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Display name | `users.name` is the display name. The user edits it. Admins can still override it. No separate `displayName` column |
| Name uniqueness | Display names are unique among non-banned users, case-insensitively. Mentions resolve by exact `@name` (`actions/issues.ts` `addComment`), so a self-chosen duplicate would misroute mention notifications and allow impersonation |
| Avatar source | Manual upload with client-side crop, plus automatic import of the Microsoft 365 photo on Microsoft sign-in. An upload or an explicit removal is never overwritten by the import |
| Timezone | Shown on the profile and card, **and** used as the reader's display zone for every date in the app. `null` falls back to `APP_TIMEZONE` |
| Extra fields | Status (emoji, text, expiry) and working hours. Pronouns and phone are out of scope |
| Directory | `/people` directory and `/people/[id]` profile, visible to every signed-in user |
| Jira | Profile and card link to the user's Jira profile when `jiraAccountId` is set |
| Storage model | Columns on `users`, registered as better-auth `user.additionalFields` with `input: false`. Mutations go through our own server actions (approach A) |
| Hover card | Base UI `PreviewCard`, data fetched lazily from a route handler |

## Data model

New columns on `users`, all nullable:

| Column | Type | Rule |
|---|---|---|
| `title` | text | ≤ 80 chars |
| `bio` | text | plain text, ≤ 280 chars, no markdown |
| `timezone` | text | an IANA zone in `Intl.supportedValuesOf("timeZone")`. `null` = `APP_TIMEZONE` |
| `working_hours` | jsonb | `{ days: number[]; start: "HH:MM"; end: "HH:MM" }`. `days` are ISO weekdays 1–7, unique, non-empty. `start < end` (no overnight ranges). Typed with `.$type<WorkingHours>()` |
| `status_emoji` | text | exactly one emoji grapheme (`Intl.Segmenter` + `\p{Extended_Pictographic}`), ≤ 32 UTF-8 bytes so ZWJ sequences fit |
| `status_text` | text | ≤ 80 chars |
| `status_expires_at` | timestamp | `null` = no expiry. Plain `timestamp`, like every other timestamp column in the schema |
| `avatar_source` | text | `'upload' \| 'microsoft' \| 'removed'`, `null` = never set |

Plus a unique index on `lower(name)` where `banned = false`. Before the migration, check the live DB for existing case-insensitive duplicates and resolve them by hand.

**Every creation path picks a free name.** The `databaseHooks.user.create.before` hook rewrites a taken name to `Name (email-local-part)`, then `Name (email-local-part) 2`, and so on. This applies to a first Microsoft sign-in, invitation acceptance, and `/setup`, so a name clash can never block a sign-in. Unbanning or renaming into a taken name returns `nameTaken`.

`image` keeps its better-auth meaning and now holds the app URL `/api/avatars/<userId>/<hash>`.

**Expiry is read-side.** `activeStatus(user, now)` returns `null` once `status_expires_at` has passed. No cron job clears stale rows. The next `setStatus` overwrites them.

**Session.** All new columns are declared in `auth.user.additionalFields` with `input: false`. They are inferred into `Session["user"]`, so the layout reads `timezone` and status without another query. The auth endpoints (`/update-user`, sign-up) cannot write them.

## Mutations

`actions/profile.ts`. Every action edits only the caller (`requireSession`), validates with zod schemas in `lib/validation.ts`, calls `recordActivity`, and returns `ActionResponse`.

- `updateProfile({ name, title, bio, timezone, workingHours })`. A duplicate name returns a translated `nameTaken` error. The unique-violation (`23505`) is mapped as well as pre-checked, so a race is still reported cleanly.
- `setStatus({ emoji, text, expiresAt })` and `clearStatus()`. The UI offers presets: 30 min, 1 h, 4 h, today, this week, a picked date, never. "Today" and "this week" end in the user's effective timezone.

Admin: `updateUserName` becomes `adminUpdateProfile` (`user:update`). It sets `name` and `title` and can remove the avatar. The "nameManagedByAdmin" copy goes away.

## Avatars

### Storage

- Key: `avatars/<userId>/<hash>`, where `hash` is the first 16 hex chars of the SHA-256 of the bytes. Identical re-uploads are idempotent, and the URL changes whenever the picture does.
- After the DB row is updated, the previous object is deleted. A failed delete is logged and ignored, because an orphan is harmless.
- The objects live in the existing `S3_BUCKET` under the new prefix. `IMGPROXY_ALLOWED_SOURCES` (`s3://<bucket>/`) already covers it, so there are no compose or env changes.

### Upload — `POST /api/avatars`

- **Client.** A crop dialog with a square viewport, pointer-drag pan and a range-input zoom. It exports `canvas.toBlob()` at 512×512 as WebP, or PNG where the browser cannot encode WebP. It is built in-house and adds no dependency.
- **Server.**
  1. Require a session. Max 5 MB.
  2. Magic-byte sniff with the helper shared with `app/api/knowledge/asset/route.ts`, extracted if needed. Accept png, jpeg, webp and avif only. Reject SVG and GIF.
  3. Hash and `putObject`.
  4. Set `image` and `avatar_source = 'upload'`.
  5. `recordActivity`, then `revalidatePath("/", "layout")`.
- **`DELETE /api/avatars`** deletes the object and sets `image = null` and `avatar_source = 'removed'`.

### Microsoft import

- **When it runs.** A better-auth `hooks.after` middleware fires on the Microsoft OAuth callback once a new session exists. It schedules `importMicrosoftAvatar(userId)` with `after()` from `next/server`, so sign-in never waits on Graph and an import failure never blocks login. The failure is logged.
- **Rule.** Import only when `avatar_source` is `null` or `'microsoft'`.
- **Fetch.**
  1. Get a token with `auth.api.getAccessToken({ body: { providerId: "microsoft", userId } })`.
  2. Call `GET https://graph.microsoft.com/v1.0/me/photos/240x240/$value`. `User.Read` is in the default scopes.
  3. On 404 (no photo), do nothing.
  4. Otherwise sniff and hash the bytes. If the hash equals the stored one, do nothing. If not, store the photo and set `avatar_source = 'microsoft'`. A photo changed in M365 therefore syncs on the next sign-in.
- **Forced import.** The account page has a **"Use Microsoft photo"** button for users with a linked Microsoft account. It runs the same function with `force: true`, which ignores `'upload'` and `'removed'`.
- `disableProfilePhoto: true` stays. Its comment is updated to point to this import.

### Serving — `GET /api/avatars/[userId]/[hash]?s=<px>`

- Requires a session only. Every signed-in user may see every avatar.
- `s` snaps up to one of {24, 32, 40, 64, 96, 128, 256}. The default is 64.
- `imgproxyUrl` gains `{ resize: "fill", width, height }`, giving `rs:fill:W:H`. The route forwards `Accept` and streams the result with `Cache-Control: private, max-age=31536000, immutable`, the same way as the knowledge assets.
- A `hash` that doesn't match the user's current `image` still serves if the object exists. Old URLs in an open tab degrade gracefully until the object is deleted, and after that they return 404 and the component falls back to initials.

### Rendering

`UserAvatar` renders `<img srcset="…?s=N 1x, …?s=2N 2x" loading="lazy" decoding="async">`. It does not use `next/image`, because imgproxy already optimises the bytes. With no image, or on `onError`, it shows initials on a background chosen deterministically from `userId` out of 8 theme tokens. Each token has a light and a dark variant with AA contrast.

## Pages

**Visibility rule.** Profile fields are visible to every signed-in user. Anything tied to a project — memberships, issues, runs — is filtered to the projects the **viewer** can read, through the existing scope helpers in `lib/authz.ts`. Banned users are hidden from non-admins (`notFound()` on their profile). Admins see them with a "Deactivated" badge.

### `/people`

- A server component loads all visible users with their profile fields, last-active time and the project ids the viewer shares with them.
- A grid of cards shows avatar 64, name, title, active status, local time and an availability dot: in working hours, outside them, or a status set.
- Search over name, title and email, plus filters for org role and project (only projects the viewer can see). Filtering runs on the client and there is no pagination: the team is dozens, not thousands. If it grows, move the filters to `searchParams` without changing the UI.
- Add a "People" sidebar item and command-palette (cmdk) entries that jump to a person.
- Add `PEOPLE` to `RESERVED_PROJECT_KEYS`. Before deploying, check the live DB for an existing project keyed `PEOPLE`.

### `/people/[id]`

- **Header:**
  - Avatar 128, name, title, org-role badge, and active status with its expiry.
  - Live local time with GMT offset and a working-hours state, e.g. "Outside working hours · back at 09:00". It is a client component ticking every minute.
- **Actions:**
  - Email (`mailto:`).
  - Teams chat (`https://teams.microsoft.com/l/chat/0/0?users=<email>`, a link only).
  - Jira profile when `jiraAccountId` is set.
  - "Edit profile" (→ `/account?tab=profile`) on your own profile.
  - "Manage" (→ `/admin/users`) for holders of `user:update`.
- **About:** the bio, member since, last active (latest `sessions.updatedAt`, as in `listUsers`).
- **Projects:** the shared projects, with this user's project role.
- **Assigned open issues:** up to 20, viewer-scoped, with a "View all" link to `/issues?assignee=<id>`. The global issues page only supports `mine=1` today, so add an `assignee` filter that goes through the same scoped query.
- **Recent runs:** the user's 10 latest runs (backup, restore, mock-time, test) in viewer-visible environments, with status and relative time. These stand in for "recent activity": `activity_log` has no project column, so it cannot be filtered by viewer, and it stays behind `audit:read`.
- `user-menu` gains "My profile" (→ `/people/<me>`) and "Set status".

### `/account?tab=profile`

The read-only `ProfileCard` becomes a form:

- Avatar: upload and crop, remove, "Use Microsoft photo".
- Name, title, bio with character counters.
- Timezone: a searchable IANA combobox with a "Detect from browser" button.
- Working hours: weekday toggles and two time inputs.
- A "View public profile" link.

Status is not part of this form. It has its own popover, opened from the user menu, with emoji presets, free text and the expiry presets.

## Components

| Unit | Responsibility |
|---|---|
| `lib/user-display.ts` | Pure helpers: `getInitials`, `avatarColor(id)`, `activeStatus(user, now)`, `isWithinWorkingHours(wh, tz, now)`, `nextWorkingStart(wh, tz, now)`. Replaces the three `getInitials` copies |
| `lib/timezone.ts` | Adds `effectiveTimeZone(user)` |
| `lib/types.ts` | `UserRef = { id; name; image }` and `UserCardData` |
| `components/ui/preview-card.tsx` | shadcn-style wrapper over Base UI `PreviewCard`, mirroring `popover.tsx` |
| `components/user/user-avatar.tsx` | Image or initials. Size tokens `xs`/`sm`/`md`/`lg`/`xl` = 20/24/32/64/128 px. `alt=""` by default, because a name is always adjacent; a `label` prop covers standalone use |
| `components/user/user-name.tsx` | `PreviewCard.Trigger` rendered as a `Link` to `/people/<id>`, with an optional avatar. `user === null` renders plain "Deleted user" text |
| `components/user/user-card.tsx` | Card body: avatar 64, name, title, role, status, local time and working-hours state, a 2-line bio clamp, Email, Teams and "View profile" |
| `components/user/status-popover.tsx` | Set and clear status |
| `components/user/avatar-cropper.tsx` | Crop dialog |

### Hover card data flow

1. On trigger `pointerenter` or `focus`, start `fetch("/api/users/<id>/card")` and keep it in a module-level `Map<id, Promise<UserCardData>>` with a 60 s TTL.
2. After `PreviewCard`'s open delay (about 600 ms, so the data is usually already there), the popup renders `use(promise)` inside `<Suspense>` with a skeleton.
3. On error, the card shows the name and a "View profile" link only.

`GET /api/users/[id]/card` requires a session and returns profile fields only: name, title, image, role, email, active status, timezone, working hours and the Jira URL. It returns no project data, so it cannot leak across projects. Banned users return 404 to non-admins.

Triggers are ordinary links. The card opens on hover and on keyboard focus and closes on Escape. On touch, `PreviewCard` doesn't open and a tap navigates to the profile. Everything on the card is also on the profile page.

### Call sites

Widen every query that selects a bare user name to also select `id` and `image`, and render `UserName`/`UserAvatar`:

- the issue board, the global and environment issue tables, and the issue detail page (assignee, creator, comment author)
- run history "triggered by" and environment recent activity
- `/admin/activity` actors
- knowledge page and revision editors
- the access matrix, project members and admin users
- the user menu and the mention suggestions

`AssigneeSelect` also shows the avatar and active status, so you see 🌴 before assigning someone on leave. Its options query adds the status columns.

Status is deliberately **not** loaded on general list queries. It appears only on the card, profile, directory, user menu and assignee picker.

## Timezone

- **Display zone.** `i18n/request.ts` and the `NextIntlClientProvider` in `app/[locale]/layout.tsx` use `effectiveTimeZone(session.user)`. Server and client formatters agree, so there is no hydration mismatch. date-fns relative times are zone-free and are unchanged.
- **Follows the user:** the Home greeting (`hourIn`) and the status presets "today" and "this week". Notification emails print no dates today, so nothing changes there.
- **Stays on server time:**
  - `ServerTime`, now labelled with its zone
  - backup and cron schedules
  - mock-time
  - run logs
- **Wall-clock inputs keep their current semantics.** The only one is `mock-time/date-time-picker.tsx`, which builds a browser-local `Date`. It gets a label naming the browser's zone. The milestone due date is date-only and is unaffected.
- **One-time hint.** When `user.timezone` is `null` and the browser's zone differs from `APP_TIMEZONE`, a dismissible banner offers to save the browser's zone. The dismissal is stored in `localStorage`.

## i18n

New `people` and `profile` namespaces, plus additions to `account` and `actionErrors`, in all five `messages/*.json` (ar, en, es, id, zh). Layouts use logical properties (`ms-`/`me-`, `start`/`end`), so the card and profile mirror correctly in Arabic.

## Migration and deploy

- One drizzle migration, `drizzle/<ts>_user_profile/migration.sql`, adds the nullable columns and the partial unique index on `lower(name)`. No backfill.
- **Pre-flight checks against the live DB:**
  - case-insensitive duplicate names among non-banned users
  - a project with key `PEOPLE`
- Apply through the established procedure: backup first, then VPN and SSH.
- No compose or env changes.

## Testing

`bun test`, pure-logic tests in the existing style:

- **`tests/profile-validation.test.ts`:**
  - valid and invalid IANA zones
  - working hours: empty or duplicate days, `start >= end`, malformed times
  - status emoji: one grapheme, ZWJ sequences accepted, two emojis rejected
  - length limits
- **`tests/user-display.test.ts`:**
  - `getInitials` with one word, unicode, empty
  - `avatarColor` is deterministic
  - `activeStatus` around the expiry
  - `isWithinWorkingHours` and `nextWorkingStart` across zones, day boundaries and weekends
- **`tests/avatar.test.ts`:**
  - size snapping
  - the signed `rs:fill` imgproxy path
  - format sniffing rejects SVG and GIF
- **`tests/authz-guards.test.ts`:** extend the structural check to the profile's project, issue and run queries.
- **`tests/reserved-paths`:** `PEOPLE` is rejected as a project key.

**Manual browser verification:**

- avatar upload, crop and removal, and the Microsoft import
- the hover card by mouse and by keyboard
- a profile viewed by a member who shares no project with its owner (no project data visible)
- changing timezone and seeing dates move
- Arabic RTL and dark mode

Then `bun run typecheck`, `bun run lint`, `bun test`.

## Out of scope

- Id-based mentions. `@name` stays text, and turning mentions into `UserName` links needs a storage-format change.
- Presence or status sync from Teams.
- Pronouns and phone/WhatsApp contact.
- A server-side directory search or pagination.
