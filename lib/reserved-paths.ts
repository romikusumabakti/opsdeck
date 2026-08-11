// URL-space reservations, kept dependency-free so the proxy (edge runtime) can
// import them without pulling in zod along with lib/validation.

// Projects are the root of their own namespace (`/[KEY]`, `/[KEY]/[envSlug]/…`),
// so a project key is also a top-level path segment. A key matching a real
// route would be unreachable, so it is rejected at creation time.
// Keep in sync with app/[locale]/*.
export const RESERVED_PROJECT_KEYS = new Set([
  "ACCOUNT",
  "ADMIN",
  // ACTIVITY/JIRA/USERS moved under /admin but stay reserved: next.config
  // redirects the old top-level paths, so they are still part of the URL space.
  "ACTIVITY",
  "API",
  "ENVIRONMENTS",
  "ISSUES",
  "JIRA",
  "KNOWLEDGE",
  "PROJECT",
  "PROJECTS",
  "SERVERS",
  "SETUP",
  "STORAGE",
  "USERS",
]);

// An environment slug is a sibling of the project's own sub-routes under
// `/[projectKey]/…`, and Next resolves a static segment before a dynamic one —
// so an environment slugged "issues" would be shadowed by the issues list.
// Keep in sync with app/[locale]/[projectKey]/*.
export const RESERVED_ENV_SLUGS = new Set([
  "environments",
  "issues",
  "members",
  "milestones",
  "new",
  "settings",
]);
