import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getAllowanceQuery } from "@/web/api/assistant";
import { listEnvironmentsQuery } from "@/web/api/environments";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { AssistantWorkspace } from "@/web/components/assistant/assistant-workspace";
import { loaderQuery } from "@/web/query-client";
import { AssistantPending } from "./-components/assistant-pending";

// The Assistant: questions about the code and issues of the caller's
// projects, each asked about the context in the composer's chip (Automatic,
// a project or an environment), answered by the model with read-only tools.
// `?c=` opens a conversation; `?env=` or `?project=` preselects the chip (the
// old project and environment assistant pages redirect here with them).
export const Route = createFileRoute("/$locale/_app/assistant")({
  validateSearch: z.object({
    c: z.uuid().optional().catch(undefined),
    project: z.uuid().optional().catch(undefined),
    env: z.uuid().optional().catch(undefined),
  }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, getAllowanceQuery()),
      loaderQuery(queryClient, listProjectsQuery()),
      loaderQuery(queryClient, listEnvironmentsQuery()),
    ]);
  },
  pendingComponent: AssistantPending,
  component: AssistantPage,
});

function AssistantPage() {
  const { c, project, env } = Route.useSearch();
  const navigate = Route.useNavigate();
  const initialContext = env
    ? ({ kind: "environment", environmentId: env } as const)
    : project
      ? ({ kind: "project", projectId: project } as const)
      : null;

  // Fills the app shell's `main` (its padding undone, then restored) so the
  // workspace scrolls its own panes, like the knowledge layout.
  return (
    <div className="-mx-4 -my-6 h-[calc(100svh-3.5rem)] overflow-hidden px-4 py-6 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <AssistantWorkspace
        initialContext={initialContext}
        conversationId={c ?? null}
        onConversationChange={(id) =>
          navigate({ search: id ? { c: id } : {}, replace: true })
        }
      />
    </div>
  );
}
