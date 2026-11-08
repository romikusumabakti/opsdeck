import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Local tunnels moved under /admin/cloudflare/local-tunnels.
export const Route = createFileRoute("/$locale/_app/admin/tunnels/$id/")({
  beforeLoad: ({ params: { locale, id } }) => {
    redirect(
      `/admin/cloudflare/local-tunnels/${encodeURIComponent(id)}`,
      locale
    );
  },
});
