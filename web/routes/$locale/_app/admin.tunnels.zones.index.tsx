import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// The zone list is a section of the Cloudflare page now.
export const Route = createFileRoute("/$locale/_app/admin/tunnels/zones/")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/cloudflare#zones", locale);
  },
});
