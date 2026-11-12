import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Milestones were removed (2026-11-12); stale bookmarks land on the overview,
// which 404s an invisible project itself.
export const Route = createFileRoute("/$locale/_app/$projectKey/milestones")({
  beforeLoad: ({ params: { locale, projectKey } }) =>
    redirect(`/${projectKey}`, locale),
});
