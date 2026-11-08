import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Local tunnels moved under /admin/cloudflare/local-tunnels.
export const Route = createFileRoute("/$locale/_app/admin/tunnels/new")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/cloudflare/local-tunnels/new", locale);
  },
});
