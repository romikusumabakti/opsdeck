import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Issues are project-level now. Keep this route as a redirect so existing
// bookmarks and links still resolve; the original query string is carried
// over verbatim.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/issues"
)({
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ params: { locale, projectKey }, location }) =>
    redirect(`/${projectKey}/issues${location.searchStr}`, locale),
});
