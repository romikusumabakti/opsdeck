import { createFileRoute } from "@tanstack/react-router";
import { safeRedirect } from "@/lib/safe-redirect";

// Placeholder so the auth gate has a typed target; Task 7 ports the sign-in
// page into this file. `redirect` is the page to return to, without its
// locale (see web/auth-gate.ts). It comes from the URL, so it is sanitised
// here: `//evil.example` would otherwise survive localizeHref as a
// protocol-relative URL and turn sign-in into an open redirect.
export const Route = createFileRoute("/$locale/sign-in")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const raw = typeof search.redirect === "string" ? search.redirect : "";
    const redirect = safeRedirect(raw, "");
    return { redirect: redirect || undefined };
  },
  component: () => null,
});
