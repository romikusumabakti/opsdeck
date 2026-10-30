import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// Access was merged into the users page as its "Project access" tab. Keep old
// bookmarks working; the users page enforces its own guard.
export const Route = createFileRoute("/$locale/_app/admin/access")({
  beforeLoad: ({ params: { locale } }) => {
    redirect("/admin/users?tab=access", locale);
  },
});
