import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Backup + restore were merged into the Databases page. Keep this route as a
// redirect so existing bookmarks and history links still resolve.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/backup-database"
)({
  beforeLoad: ({ params: { locale, projectKey, envSlug } }) =>
    redirect(`/${projectKey}/${envSlug}/databases?tab=backup`, locale),
});
