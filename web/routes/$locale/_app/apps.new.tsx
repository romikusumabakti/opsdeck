import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// New app is gone: an app is registered by its first environment's
// repository, on a project's New environment page. The projects list says
// where to start.
export const Route = createFileRoute("/$locale/_app/apps/new")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/projects?newEnvironment=1", locale);
  },
});
