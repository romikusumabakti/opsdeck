import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// An app's page moved under admin Repositories; old links land there.
export const Route = createFileRoute("/$locale/_app/apps/$appKey/")({
  beforeLoad: ({ params: { locale, appKey } }) => {
    redirect(`/admin/repositories/${encodeURIComponent(appKey)}`, locale);
  },
});
