import { headers } from "next/headers";
import { redirect } from "@/i18n/navigation";
import { auth, ROLE_ADMIN } from "./auth";

export async function getServerSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

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

export function isAdmin(session: { user: { role?: string | null } }): boolean {
  return session.user.role === ROLE_ADMIN;
}

/**
 * Require an authenticated admin. Members get redirected to the home page —
 * we don't reveal "forbidden" because the only non-admin role is `member` and
 * they shouldn't normally see admin URLs (UI hides them).
 */
export async function requireAdmin() {
  const session = await requireSession();
  if (!isAdmin(session)) {
    await redirect("/");
    throw new Error("redirect did not abort");
  }
  return session;
}
