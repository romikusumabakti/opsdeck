import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Zone forms moved under /admin/cloudflare/zones.
export const Route = createFileRoute("/$locale/_app/admin/tunnels/zones/new")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/cloudflare/zones/new", locale);
  },
});
