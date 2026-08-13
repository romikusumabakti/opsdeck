import { describe, expect, it } from "bun:test";
import { canonicalProjectPath } from "@/lib/canonical-path";

// Projects own the root namespace, so the proxy has to tell a project key
// apart from a top-level route and normalise its casing without ever touching
// the app's own routes.
describe("canonicalProjectPath", () => {
  it.each([
    ["/TMEM", null],
    ["/TMEM/dev", null],
    ["/TMEM/dev/services/db/logs", null],
    ["/TMEM/issues/42", null],
  ])("leaves canonical %s alone", (path, expected) => {
    expect(canonicalProjectPath(path)).toBe(expected);
  });

  it.each([
    ["/tmem", "/TMEM"],
    ["/TMem", "/TMEM"],
    ["/tmem/DEV", "/TMEM/dev"],
    ["/TMEM/Dev/services", "/TMEM/dev/services"],
    ["/tmem/ISSUES/42", "/TMEM/issues/42"],
  ])("canonicalises %s", (path, expected) => {
    expect(canonicalProjectPath(path)).toBe(expected);
  });

  // Application routes must never be mistaken for a project key.
  it.each([
    "/",
    "/projects",
    "/projects/new",
    "/issues",
    "/servers/abc",
    "/storage/new",
    "/knowledge/some-doc",
    "/account/change-password",
    "/sign-in",
    "/environments/new",
    "/project/TMEM",
    "/admin",
    "/admin/users",
    "/admin/jira/new",
    "/admin/activity",
  ])("ignores route %s", (path) => {
    expect(canonicalProjectPath(path)).toBeNull();
  });
});
