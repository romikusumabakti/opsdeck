import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { requireOrgRole } from "@/web/project-guard";

// The admin area has no dashboard of its own — it's a container for the
// sections listed in the sidebar. Land on Users (people and their project
// access) when the role may list users, else on Activity, which every role
// that reaches the admin area (audit:read) can open.
export const Route = createFileRoute("/$locale/_app/admin/")({
  beforeLoad: async ({ params: { locale }, context: { queryClient } }) => {
    const me = await requireOrgRole(queryClient, { audit: ["read"] });
    redirect(
      canOrg(me.orgRole, { user: ["list"] })
        ? "/admin/users"
        : "/admin/activity",
      locale
    );
  },
});
