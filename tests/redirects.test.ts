import { describe, expect, it } from "vitest";
import { resolveRedirect } from "@/lib/redirects";

// One table for every URL the app used to answer elsewhere: the missing locale
// prefix (next-intl's middleware), the /users, /jira and /activity moves
// (next.config.ts redirects) and the canonical project-key casing (proxy.ts).
describe("resolveRedirect", () => {
  it.each([
    ["/servers", "/en/servers"],
    ["/", "/en"],
    ["/admin/users", "/en/admin/users"],
    // Unknown locale-like segments are paths, not locales.
    ["/fr/servers", "/en/fr/servers"],
    ["/english", "/en/english"],
  ])("prefixes the default locale on %s", (path, to) => {
    expect(resolveRedirect(path)).toEqual({ to, status: 302 });
  });

  it.each([
    ["/id/users/abc", "/id/admin/users/abc"],
    ["/en/jira", "/en/admin/jira"],
    ["/en/users", "/en/admin/users"],
    ["/id/jira/settings", "/id/admin/jira/settings"],
    ["/zh/activity", "/zh/admin/activity"],
  ])("moves %s under /admin", (path, to) => {
    expect(resolveRedirect(path)).toEqual({ to, status: 302 });
  });

  // Ported from tests/routing.test.ts: non-canonical project paths take the
  // canonical casing with a permanent redirect, keeping the locale.
  it.each([
    ["/en/tmem", "/en/TMEM"],
    ["/en/TMem", "/en/TMEM"],
    ["/id/tmem/DEV", "/id/TMEM/dev"],
    ["/en/TMEM/Dev/services", "/en/TMEM/dev/services"],
    ["/zh/tmem/ISSUES/42", "/zh/TMEM/issues/42"],
  ])("canonicalises %s", (path, to) => {
    expect(resolveRedirect(path)).toEqual({ to, status: 308 });
  });

  // Ported from the app/[locale]/project and projects/[key] shims: projects
  // moved to the root namespace, and an issue number used to follow the key.
  it.each([
    ["/en/projects/tmem", "/en/TMEM"],
    ["/id/projects/TMEM", "/id/TMEM"],
    ["/en/projects/tmem/issues/42", "/en/TMEM/issues/42"],
    ["/en/projects/tmem/dev/services", "/en/TMEM/dev/services"],
    ["/en/project/tmem", "/en/TMEM"],
    ["/en/project/TMEM/42", "/en/TMEM/issues/42"],
    ["/en/project/TMEM/42/extra", "/en/TMEM/issues/42/extra"],
    ["/en/project/TMEM/settings", "/en/TMEM/settings"],
    ["/en/project/tmem/", "/en/TMEM"],
    // The flat create-environment URL, once /projects/new.
    ["/en/projects/new", "/en/environments/new"],
  ])("moves the legacy project URL %s to %s", (path, to) => {
    expect(resolveRedirect(path)).toEqual({ to, status: 308 });
  });

  it.each([
    "/en/servers",
    "/en",
    "/en/TMEM",
    "/en/TMEM/dev",
    "/en/TMEM/dev/services/db/logs",
    "/en/TMEM/issues/42",
    "/en/projects",
    "/en/issues",
    "/en/servers/abc",
    "/en/storage/new",
    "/en/knowledge/some-doc",
    "/en/account/change-password",
    "/en/sign-in",
    "/en/environments/new",
    "/en/projects/0199a1b2-0000-7000-8000-000000000001",
    "/en/projects/0199a1b2-0000-7000-8000-000000000001/services",
    "/en/admin",
    "/en/admin/users",
    "/en/admin/jira/new",
    "/en/admin/activity",
  ])("leaves %s alone", (path) => {
    expect(resolveRedirect(path)).toBeNull();
  });

  // Ported from tests/next-config-redirects.test.ts: the API, the favicon and
  // the built assets are never redirected — /api/users/<id>/card once went to
  // a non-existent /api/admin/users/... path.
  it.each([
    "/api/health",
    "/api/users/0199a1b2-0000-7000-8000-000000000001/card",
    "/api/activity",
    "/api",
    "/brand/icon.svg",
    "/assets/index-abc123.js",
  ])("never redirects %s", (path) => {
    expect(resolveRedirect(path)).toBeNull();
  });
});
