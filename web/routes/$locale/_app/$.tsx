import { createFileRoute, notFound } from "@tanstack/react-router";

// Any URL under a locale that no page claims. Matching it here, inside the
// shell, lets the `_app` route's not-found screen keep the sidebar and header
// around the 404, as the old layout did — the same path a page's own
// `throw notFound()` takes.
export const Route = createFileRoute("/$locale/_app/$")({
  loader: () => {
    throw notFound();
  },
});
