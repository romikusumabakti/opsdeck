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

// The method of the session a plugin endpoint rotates, when the request is
// not a sign-in but swaps the session row. `previous` is the method of the
// session the request ran under. Returns undefined when `path` is not such an
// endpoint (the caller then uses signInMethodFor).
//  - Confirming a new authenticator (verify-totp with a session) keeps a
//    strong method, so a passkey or Microsoft session is not relabelled; a
//    weak one becomes password+totp, as the user just proved the code.
//  - Disabling two-factor keeps the method, except password+totp, which falls
//    back to password: the second factor is gone.
export function signInMethodForRotation(
  path: string,
  previous: string | null | undefined
): SignInMethod | null | undefined {
  const prev = (previous ?? null) as SignInMethod | null;
  if (path === "/two-factor/verify-totp") {
    return isStrongSignIn(prev) ? prev : "password+totp";
  }
  if (path === "/two-factor/disable") {
    return prev === "password+totp" ? "password" : prev;
  }
  return undefined;
}

export function isStrongSignIn(method: string | null | undefined): boolean {
  return method != null && STRONG.has(method);
}

// The refusal for a weak session on a risky action: one message and one code
// for the org guards, the secret reveal and the better-auth admin hook.
export const STRONG_SIGN_IN_MESSAGE =
  "Sign in with a passkey, Microsoft, or a password and an authenticator code to do this.";
export const STRONG_SIGN_IN_CODE = "strong_sign_in_required";
