// How a session was established. Recorded once, when the session row is
// created (see the session hook in lib/auth), and read later to decide whether
// a risky action needs a fresh strong sign-in. A session with no recorded
// method (null) counts as weak.
export type SignInMethod =
  | "password"
  | "password+totp"
  | "passkey"
  | "microsoft";

const STRONG: ReadonlySet<string> = new Set<SignInMethod>([
  "password+totp",
  "passkey",
  "microsoft",
]);

// Maps the better-auth endpoint that created a session to its sign-in method.
// Returns null for endpoints that create a session without proving identity,
// e.g. passkey registration or impersonation.
export function signInMethodFor(
  path: string,
  params?: Record<string, string | undefined>
): SignInMethod | null {
  if (path === "/sign-in/email") return "password";
  if (
    path === "/two-factor/verify-totp" ||
    path === "/two-factor/verify-backup-code"
  ) {
    return "password+totp";
  }
  if (path === "/passkey/verify-authentication") return "passkey";
  if (path.startsWith("/callback/") && params?.id === "microsoft") {
    return "microsoft";
  }
  return null;
}

export function isStrongSignIn(method: string | null | undefined): boolean {
  return method != null && STRONG.has(method);
}
