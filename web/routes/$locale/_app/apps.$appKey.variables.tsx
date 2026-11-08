import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// An app's variable templates moved under admin Repositories; old links land
// there.
export const Route = createFileRoute("/$locale/_app/apps/$appKey/variables")({
  beforeLoad: ({ params: { locale, appKey } }) => {
    redirect(
      `/admin/repositories/${encodeURIComponent(appKey)}/variables`,
      locale
    );
  },
});
