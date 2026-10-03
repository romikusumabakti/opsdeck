import { headers } from "next/headers";
import { cache } from "react";
import { redirect } from "@/i18n/navigation";
import { auth } from "./auth";

/**
 * The current session, memoized for the lifetime of one request.
 *
 * `auth.api.getSession` re-parses the cookie and re-reads the `sessions` row on
 * every call, and this is called from ~180 sites — a single page render fans out
 * through the layout, its nested layouts, and every server action or data
 * helper it awaits, each of which calls `requireSession()` on its own. Without
 * this wrapper that is a fresh round-trip per call for an answer that cannot
 * change mid-request. React's `cache` scopes the memo to the request, so
 * concurrent requests never share a session.
 *
 * NOT the same thing as better-auth's `session.cookieCache`, which is
 * deliberately left off: that caches across requests in a signed cookie, so a
 * revoked session (account > sessions) or a ban would keep working until the
 * cookie's TTL expired. This wrapper has no such window.
 */
export const getServerSession = cache(async () => {
  return auth.api.getSession({
    headers: await headers(),
  });
});

export async function requireSession() {
  const session = await getServerSession();
  if (!session) {
    // Proxy only checks cookie presence; a stale cookie reaches here.
    // `redirect` is typed `void`, so throw to narrow the return type for
    // callers that read `session.user.*` directly afterwards.
    await redirect("/sign-in");
    throw new Error("redirect did not abort");
  }
  return session;
}
