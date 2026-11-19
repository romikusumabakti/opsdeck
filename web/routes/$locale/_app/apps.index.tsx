import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Apps became Services under admin (Stage 8); old links land there.
export const Route = createFileRoute("/$locale/_app/apps/")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/services", locale);
  },
});
