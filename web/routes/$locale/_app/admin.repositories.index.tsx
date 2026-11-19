import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Admin › Repositories became Admin › Services (Stage 8); old links land there.
export const Route = createFileRoute("/$locale/_app/admin/repositories/")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/services", locale);
  },
});
