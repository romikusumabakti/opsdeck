import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { ProjectRoleProvider } from "@/components/project-role";
import { getAllowanceQuery } from "@/web/api/assistant";
import {
  getProjectByKeyWithEnvironmentsQuery,
  getProjectWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import { AssistantWorkspace } from "@/web/components/assistant/assistant-workspace";
import { requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { AssistantPending } from "./-components/project/assistant-pending";

// The project's Assistant: questions about the code and issues of the
// project, each about its branches or one environment's running commits,
// answered by the model with read-only tools. `?c=` opens a conversation,
// `?env=` preselects an environment (old environment links redirect here).
export const Route = createFileRoute("/$locale/_app/$projectKey/assistant")({
  validateSearch: z.object({
    c: z.uuid().optional().catch(undefined),
    env: z.uuid().optional().catch(undefined),
  }),
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    const role = await requireProjectRole(queryClient, project.id, {
      assistant: ["use"],
    });
    return { projectId: project.id, projectName: project.name, role };
  },
  loader: async ({ context: { queryClient, projectId } }) => {
    await Promise.all([
      loaderQuery(queryClient, getAllowanceQuery()),
      loaderQuery(queryClient, getProjectWithEnvironmentsQuery(projectId)),
    ]);
  },
  pendingComponent: AssistantPending,
  component: AssistantPage,
});

function AssistantPage() {
  const { projectId, projectName, role } = Route.useRouteContext();
  const { c, env } = Route.useSearch();
  const navigate = Route.useNavigate();

  // Fills the app shell's `main` (its padding undone, then restored) so the
  // workspace scrolls its own panes, like the knowledge layout.
  return (
    <ProjectRoleProvider role={role}>
      <div className="-mx-4 -my-6 h-[calc(100svh-3.5rem)] overflow-hidden px-4 py-6 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <AssistantWorkspace
          projectId={projectId}
          projectName={projectName}
          initialEnvironmentId={env ?? null}
          conversationId={c ?? null}
          onConversationChange={(id) =>
            navigate({
              search: id ? { c: id } : {},
              replace: true,
            })
          }
        />
      </div>
    </ProjectRoleProvider>
  );
}
