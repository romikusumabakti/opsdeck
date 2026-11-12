import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Variables moved into the environment settings as a tab. Keep this route as a
// redirect so existing bookmarks and links still resolve; the original query
// string is carried over and `tab` is forced to variables. The settings route
// guards `environment:update` and the tab gates `variable:read`.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/variables"
)({
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ params: { locale, projectKey, envSlug }, location }) => {
    const params = new URLSearchParams(location.searchStr);
    params.set("tab", "variables");
    return redirect(`/${projectKey}/${envSlug}/settings?${params}`, locale);
  },
});
