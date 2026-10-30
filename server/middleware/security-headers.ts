import { createMiddleware } from "hono/factory";

// Security response headers.
//
// They live in the app rather than in the Caddyfile so they also apply in
// development and to anyone reaching the container directly — Caddy is the
// only public surface today, but a header set is worth little if it depends on
// the proxy staying in the path.
//
// Deliberately NOT set:
//   - Strict-Transport-Security. The edge serves plain HTTP by design (see the
//     Caddyfile); browsers ignore HSTS over HTTP anyway, and shipping it would
//     be a foot-gun the day someone terminates TLS with a private CA.
//   - A full Content-Security-Policy. Locking down `script-src` needs a
//     per-request nonce or hash for every inline script the client ships; done
//     blind it silently breaks the app. `frame-ancestors` is the part that
//     needs no nonce, so that ships now and the rest is a separate, testable
//     change.
//   - X-Powered-By. Hono never sends it; don't advertise the framework.
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  // Clickjacking. No part of the app frames itself, so deny outright.
  // frame-ancestors is the modern control; X-Frame-Options covers browsers
  // that predate it. Both, because they disagree on nothing here.
  ["Content-Security-Policy", "frame-ancestors 'none'"],
  ["X-Frame-Options", "DENY"],
  // Stop MIME sniffing. Matters most on the file-explorer and knowledge-asset
  // routes, which stream user-supplied bytes back out.
  ["X-Content-Type-Options", "nosniff"],
  // Don't leak internal paths (project keys, environment slugs, issue numbers)
  // in the Referer header on outbound links.
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  // Turn off device APIs the app never uses. `publickey-credentials-get` is
  // listed explicitly, at its default of `self`, so a later edit to this list
  // can't silently disable passkey sign-in.
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=(), publickey-credentials-get=(self)",
  ],
];

// Applied after the handler so they land on every response, including the ones
// onError renders and raw `Response`s handed back by better-auth or a download.
export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  for (const [name, value] of SECURITY_HEADERS) {
    c.res.headers.set(name, value);
  }
});
