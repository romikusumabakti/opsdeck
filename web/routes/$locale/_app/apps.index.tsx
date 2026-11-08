import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Apps moved under admin as Repositories; old links land there.
export const Route = createFileRoute("/$locale/_app/apps/")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/repositories", locale);
  },
});
