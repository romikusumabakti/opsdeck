import { createFileRoute } from "@tanstack/react-router";

// Placeholder so the auth gate has a typed target; Task 7 ports the sign-in
// page into this file. `redirect` is the page to return to, without its
// locale (see web/auth-gate.ts).
export const Route = createFileRoute("/$locale/sign-in")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: () => null,
});
