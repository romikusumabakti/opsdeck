import { createFileRoute } from "@tanstack/react-router";
import { LocaleNotFoundContent } from "@/web/components/locale-fallbacks";

// Any URL under a locale that no page claims. Matching it here, inside the
// shell, keeps the sidebar and header around the 404 as the old layout did.
export const Route = createFileRoute("/$locale/_app/$")({
  component: LocaleNotFoundContent,
});
