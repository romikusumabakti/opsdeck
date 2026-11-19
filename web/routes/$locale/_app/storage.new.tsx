import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { legacyStorageIndexHref } from "./-components/storage-redirect";

// Connections are added in their environment now; see storage.index.tsx.
export const Route = createFileRoute("/$locale/_app/storage/new")({
  beforeLoad: async ({ params: { locale }, context: { queryClient } }) =>
    redirect(await legacyStorageIndexHref(queryClient), locale),
});
