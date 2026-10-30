import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireOrgRole } from "@/web/project-guard";

// Baseline gate for the admin area: audit:read. It is not sufficient on its
// own (a layout's guard does not re-run on a sibling navigation it already
// passed), so every child page also checks the permission it actually needs.
export const Route = createFileRoute("/$locale/_app/admin")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { audit: ["read"] });
  },
  component: Outlet,
});
