import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// The Services page was folded into the Dashboard's Stack card. Keep this
// route as a redirect so bookmarks and the legacy /projects/<id>/services
// splat still resolve.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/services/"
)({
  beforeLoad: ({ params: { locale, projectKey, envSlug } }) =>
    redirect(`/${projectKey}/${envSlug}`, locale),
});
