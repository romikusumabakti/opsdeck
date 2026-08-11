/**
 * Sanitise a user-supplied post-login redirect target.
 *
 * The `?redirect=` query parameter ends up in `router.push()` and in the OAuth
 * `callbackURL`, so an attacker-controlled absolute URL would turn the sign-in
 * page into an open redirect: the victim authenticates on the real panel and is
 * then dropped on a look-alike host. Only same-origin, single-slash paths are
 * allowed through; everything else falls back to the app root.
 */
export function safeRedirect(
  target: string | null | undefined,
  fallback = "/"
): string {
  if (!target) return fallback;

  // Must be a root-relative path. `//evil.example` and `/\evil.example` are
  // both protocol-relative URLs in a browser, so they are rejected too.
  if (!target.startsWith("/")) return fallback;
  if (target.startsWith("//") || target.startsWith("/\\")) return fallback;

  // Control characters (newline, tab, NUL, …) can be used to smuggle a scheme
  // past the checks above, so reject anything below U+0020.
  for (const char of target) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return fallback;
  }

  return target;
}
