import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Security response headers.
//
// They live here rather than in the Caddyfile so they also apply under
// `next dev` and to anyone reaching the container directly — Caddy is the only
// public surface today, but a header set is worth little if it depends on the
// proxy staying in the path.
//
// Deliberately NOT set:
//   - Strict-Transport-Security. The edge serves plain HTTP by design (see the
//     Caddyfile); browsers ignore HSTS over HTTP anyway, and shipping it would
//     be a foot-gun the day someone terminates TLS with a private CA.
//   - A full Content-Security-Policy. Locking down `script-src` needs a
//     per-request nonce threaded through proxy.ts and every inline Next
//     bootstrap script; done blind it silently breaks the app. `frame-ancestors`
//     is the part that needs no nonce, so that ships now and the rest is a
//     separate, testable change.
const SECURITY_HEADERS = [
  // Clickjacking. No part of the app frames itself, so deny outright.
  // frame-ancestors is the modern control; X-Frame-Options covers browsers
  // that predate it. Both, because they disagree on nothing here.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  // Stop MIME sniffing. Matters most on the file-explorer and knowledge-asset
  // routes, which stream user-supplied bytes back out.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Don't leak internal paths (project keys, environment slugs, issue numbers)
  // in the Referer header on outbound links.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Turn off device APIs the app never uses. `publickey-credentials-get` is
  // listed explicitly, at its default of `self`, so a later edit to this list
  // can't silently disable passkey sign-in.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), interest-cohort=(), publickey-credentials-get=(self)",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Don't advertise the framework.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // These three moved under /admin. Keep old bookmarks working; the locale
  // prefix is always present (routing.localePrefix === "always").
  async redirects() {
    return [
      {
        source: "/:locale/:section(users|jira|activity)/:rest*",
        destination: "/:locale/admin/:section/:rest*",
        permanent: false,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
