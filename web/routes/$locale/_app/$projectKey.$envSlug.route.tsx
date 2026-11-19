import {
  createFileRoute,
  notFound,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import * as React from "react";
import { ProjectRoleProvider } from "@/components/project-role";
import { withEnvironmentPath } from "@/lib/canonical-path";
import { ApiError } from "@/web/api/client";
import {
  recordEnvironmentAccess,
  resolveEnvironmentQuery,
} from "@/web/api/environments";
import { EnvError } from "./-components/env/env-error";
import { TeardownBanner } from "./-components/env/teardown-banner";

// The environment area (the port of `[projectKey]/[envSlug]/layout.tsx`).
// `/<KEY>/<envSlug>` resolves to an environment id and the caller's role on
// its project; an unknown key or slug, or an invisible project, is a 404. The
// server enforces the same rules on every endpoint, regardless. An old slug
// (renamed since, maybe in a project the environment left) resolves too: the
// page replaces it with the environment's current `/<KEY>/<slug>`, keeping
// the rest of the path, the query and the hash, before anything renders.
export const Route = createFileRoute("/$locale/_app/$projectKey/$envSlug")({
  beforeLoad: async ({
    params: { projectKey, envSlug },
    context: { queryClient },
    location,
  }) => {
    const resolved = await queryClient
      .query(resolveEnvironmentQuery(projectKey, envSlug))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) throw notFound();
        throw error;
      });
    // Only a full answer moves the page (a server from before renames sends
    // no key/slug).
    const moved =
      !!resolved.projectKey &&
      !!resolved.envSlug &&
      (resolved.projectKey !== projectKey || resolved.envSlug !== envSlug);
    if (moved) {
      const path = withEnvironmentPath(
        location.pathname,
        resolved.projectKey,
        resolved.envSlug
      );
      throw redirect({
        href: `${path}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
        replace: true,
      });
    }
    return resolved;
  },
  // Another environment (picked in the breadcrumb) is another page: remount,
  // so forms and local state never carry the previous environment's values.
  remountDeps: ({ params }) => ({
    projectKey: params.projectKey,
    envSlug: params.envSlug,
  }),
  errorComponent: EnvError,
  component: EnvironmentLayout,
});

function EnvironmentLayout() {
  const { environmentId, role } = Route.useRouteContext();
  const { projectKey } = Route.useParams();

  // Bump the environment's recency for this user so the header switcher lists
  // it first. Runs on entering the environment (and when switching to
  // another), not on navigation between its pages and not on a link preload,
  // which matches "opened this environment".
  React.useEffect(() => {
    recordEnvironmentAccess(environmentId).catch(() => {});
  }, [environmentId]);

  return (
    <ProjectRoleProvider role={role}>
      {/* While the environment is being deleted, on every page. */}
      <TeardownBanner environmentId={environmentId} projectKey={projectKey} />
      <Outlet />
    </ProjectRoleProvider>
  );
}
