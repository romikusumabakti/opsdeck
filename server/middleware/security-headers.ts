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
//   - X-Powered-By. Hono never sends it; don't advertise the framework.
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  // Clickjacking. No part of the app frames itself, so deny outright.
  // frame-ancestors is the modern control; X-Frame-Options covers browsers
  // that predate it. Both, because they disagree on nothing here.
  ["X-Frame-Options", "DENY"],
  // Content-Security-Policy, scoped to what it can enforce without breaking
  // the app:
  //   - script-src 'self': only scripts served from this origin run, with no
  //     inline scripts and no `unsafe-eval`. The client ships none: the theme
  //     bootstrap is /theme-init.js (public/), not an inline <script>. This
  //     does not restrict styles, images, fonts or fetch/WebSocket targets.
  //   - 'wasm-unsafe-eval': lets WebAssembly compile (the terminal and the
  //     file editor use it) without allowing eval() or new Function().
  //   - object-src 'none', base-uri 'none': no plugins, and no injected <base>
  //     rewriting relative script URLs.
  //   - frame-ancestors 'none': clickjacking (see X-Frame-Options above).
  // worker-src falls back to script-src, so workers must come from 'self' too.
  [
    "Content-Security-Policy",
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  ],
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
