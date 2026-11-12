import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Members moved into Project settings. Keep this route as a redirect so
// existing bookmarks and history links still resolve.
export const Route = createFileRoute("/$locale/_app/$projectKey/members")({
  beforeLoad: ({ params: { locale, projectKey } }) =>
    redirect(`/${projectKey}/settings?tab=members`, locale),
});
