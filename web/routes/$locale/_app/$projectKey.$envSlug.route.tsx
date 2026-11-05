import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import * as React from "react";
import { ProjectRoleProvider } from "@/components/project-role";
import { ApiError } from "@/web/api/client";
import {
  recordEnvironmentAccess,
  resolveEnvironmentQuery,
} from "@/web/api/environments";
import { EnvError } from "./-components/env/env-error";

// The environment area (the port of `[projectKey]/[envSlug]/layout.tsx`).
// `/<KEY>/<envSlug>` resolves to an environment id and the caller's role on
// its project; an unknown key or slug, or an invisible project, is a 404. The
// server enforces the same rules on every endpoint, regardless.
export const Route = createFileRoute("/$locale/_app/$projectKey/$envSlug")({
  beforeLoad: async ({
    params: { projectKey, envSlug },
    context: { queryClient },
  }) => {
    try {
      return await queryClient.query(
        resolveEnvironmentQuery(projectKey, envSlug)
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    }
  },
  errorComponent: EnvError,
  component: EnvironmentLayout,
});

function EnvironmentLayout() {
  const { environmentId, role } = Route.useRouteContext();

  // Bump the environment's recency for this user so the header switcher lists
  // it first. Runs on entering the environment (and when switching to
  // another), not on navigation between its pages and not on a link preload,
  // which matches "opened this environment".
  React.useEffect(() => {
    recordEnvironmentAccess(environmentId).catch(() => {});
  }, [environmentId]);

  return (
    <ProjectRoleProvider role={role}>
      <Outlet />
    </ProjectRoleProvider>
  );
}
