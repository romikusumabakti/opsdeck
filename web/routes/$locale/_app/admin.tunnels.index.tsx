import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Tunnels moved onto the one Cloudflare page; old links land there.
export const Route = createFileRoute("/$locale/_app/admin/tunnels/")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/cloudflare", locale);
  },
});
