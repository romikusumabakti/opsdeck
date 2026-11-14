import type { recordActivity } from "@/lib/activity";
import { signInMethodFor } from "@/lib/sign-in-method";

type ActivityInput = Parameters<typeof recordActivity>[0];

type SessionUser = {
  user: { id: string; email: string; twoFactorEnabled?: boolean | null };
};

// Sign-in attempts that are worth a "failed" row: the password step and the
// two second-factor checks. Failed passkey and Microsoft sign-ins are not
// logged.
const FAILED_SIGN_IN_METHODS: Record<string, string> = {
  "/sign-in/email": "password",
  "/two-factor/verify-totp": "password+totp",
  "/two-factor/verify-backup-code": "password+totp",
};

// Pure: turns what a better-auth `after` hook can see into the activity row to
// write, or null when the request is not one we log. The hook only gathers the
// inputs and calls recordActivity (see lib/auth).
export function authActivityFor(input: {
  path: string;
  params?: Record<string, string | undefined>;
  body?: unknown;
  // Set when the request created a session.
  newSession:
    | (SessionUser & {
        session: {
          ipAddress?: string | null;
          userAgent?: string | null;
          signInMethod?: string | null;
        };
      })
    | null;
  // The session the request ran under (better-auth's `ctx.context.session`,
  // which stays the pre-request session), for endpoints on a signed-in user.
  session?: SessionUser | null;
  error: { status: number; code?: string } | null;
  ip: string | null;
  userAgent: string | null;
}): ActivityInput | null {
  const { path, newSession, error } = input;
  const ip = input.ip ?? "";
  const userAgent = input.userAgent ?? "";

  // Confirming a new authenticator: verify-totp from a signed-in user who has
  // not enabled two-factor yet. That is the step that turns it on (and swaps
  // the session), not a sign-in; a wrong code here is a typo, not an attempt.
  const enrolling =
    path === "/two-factor/verify-totp" &&
    input.session != null &&
    input.session.user.twoFactorEnabled === false;
  if (enrolling) {
    if (error || !input.session) return null;
    return userRow("auth.two_factor_enabled", input.session, ip, userAgent);
  }

  const failedMethod = FAILED_SIGN_IN_METHODS[path];
  if (failedMethod && error) {
    const email = (input.body as { email?: unknown } | null | undefined)?.email;
    return {
      actorId: null,
      action: "auth.sign_in_failed",
      data: {
        method: failedMethod,
        email: typeof email === "string" ? email.toLowerCase() : "",
        ip,
        userAgent,
        reason: error.code ?? "unknown",
      },
    };
  }
  if (error) return null;

  if (path === "/two-factor/disable") {
    if (!input.session) return null;
    return userRow("auth.two_factor_disabled", input.session, ip, userAgent);
  }

  // A passkey registered from any session is a way to sign in strongly later,
  // so adding and removing one is logged under the session user.
  if (path === "/passkey/verify-registration" && input.session) {
    return userRow("auth.passkey_added", input.session, ip, userAgent);
  }
  if (path === "/passkey/delete-passkey" && input.session) {
    return userRow("auth.passkey_removed", input.session, ip, userAgent);
  }

  const method = signInMethodFor(path, input.params);
  if (method && newSession) {
    return {
      actorId: newSession.user.id,
      action: "auth.signed_in",
      entityType: "user",
      entityId: newSession.user.id,
      data: { method, ip, userAgent },
    };
  }
  return null;
}

function userRow(
  action: string,
  session: SessionUser,
  ip: string,
  userAgent: string
): ActivityInput {
  return {
    actorId: session.user.id,
    action,
    entityType: "user",
    entityId: session.user.id,
    data: { ip, userAgent },
  };
}

// First hop of x-forwarded-for, then cf-connecting-ip (the panel sits behind
// a Cloudflare tunnel).
export function clientIpFrom(headers: Headers | undefined): string | null {
  const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers?.get("cf-connecting-ip")?.trim() || null;
}
