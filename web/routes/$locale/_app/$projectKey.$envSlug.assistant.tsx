import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";

// The Assistant moved to `/assistant`. Old environment links land there with
// this environment preselected as the question's context.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/assistant"
)({
  beforeLoad: ({ params: { locale }, context: { environmentId } }) =>
    redirect(`/assistant?env=${encodeURIComponent(environmentId)}`, locale),
});
