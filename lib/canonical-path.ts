import { RESERVED_PROJECT_KEYS } from "@/lib/reserved-paths";

// Projects sit at the root of the URL space (`/[KEY]`, `/[KEY]/[envSlug]/…`).
// Keys are stored uppercase, slugs lowercase, and both lookups normalise their
// input — so `/tmem/DEV` would serve the same page as `/TMEM/dev` under a second
// URL. The proxy redirects to the canonical casing instead of answering on both.
// Dependency-free so it runs in the edge middleware.
const PROJECT_KEY_SEGMENT = /^[A-Za-z][A-Za-z0-9]{1,9}$/;

/**
 * Canonical form of a locale-stripped path, or null when it is already
 * canonical or is not a project path at all.
 */
export function canonicalProjectPath(stripped: string): string | null {
  const segments = stripped.split("/").filter(Boolean);
  const [key, second, ...rest] = segments;
  if (!key || !PROJECT_KEY_SEGMENT.test(key)) return null;
  const upperKey = key.toUpperCase();
  // A top-level route (/projects, /issues, …) is never a project key.
  if (RESERVED_PROJECT_KEYS.has(upperKey)) return null;
  // Everything below the key is lowercase by construction: environment slugs,
  // the project's own sub-routes, service roles. Issue numbers are digits.
  const lowerSecond = second?.toLowerCase();
  if (key === upperKey && second === lowerSecond) return null;
  return ["", upperKey, ...(lowerSecond ? [lowerSecond] : []), ...rest].join(
    "/"
  );
}
