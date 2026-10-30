import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

// Match paths with Next's own matcher, so the test sees what the router sees.
async function redirectFor(pathname: string): Promise<string | null> {
  for (const rule of (await nextConfig.redirects?.()) ?? []) {
    const params = getPathMatch(rule.source)(pathname);
    if (params) return rule.destination;
  }
  return null;
}

describe("legacy /users, /jira, /activity redirects", () => {
  it.each(["/en/users", "/id/jira/settings", "/zh/activity"])(
    "redirect %s",
    async (path) => {
      expect(await redirectFor(path)).not.toBeNull();
    }
  );

  // `:locale` used to match any segment, so the API's /api/users/<id>/card
  // was redirected to a non-existent /api/admin/users/... path.
  it.each([
    "/api/users/0199a1b2-0000-7000-8000-000000000001/card",
    "/api/activity",
    "/_next/users/x",
  ])("leave %s alone", async (path) => {
    expect(await redirectFor(path)).toBeNull();
  });
});
