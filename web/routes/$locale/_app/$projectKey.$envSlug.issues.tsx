import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Issues are project-level now. Keep this route as a redirect so existing
// bookmarks and links still resolve; every incoming search param is carried
// over unchanged.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/issues"
)({
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ params: { locale, projectKey }, search }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    return redirect(`/${projectKey}/issues${qs ? `?${qs}` : ""}`, locale);
  },
});
