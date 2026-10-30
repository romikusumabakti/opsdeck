import { getServerSession } from "@/server/context";
import { unauthorized } from "@/server/errors";

// The memoized session lives with the rest of the request context; re-exported
// so the existing `@/lib/auth-session` imports keep working.
export { getServerSession };

export async function requireSession() {
  const session = await getServerSession();
  // No cookie, or a stale one (expired, revoked, banned user). The client
  // answers a 401 by sending the user to sign-in.
  if (!session) unauthorized();
  return session;
}
