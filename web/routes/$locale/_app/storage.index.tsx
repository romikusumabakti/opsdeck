import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { legacyStorageIndexHref } from "./-components/storage-redirect";

// The global Storage page is gone: connections live in their environment
// (Admin › Storage for the unassigned ones). Old links land on the nearest
// page the caller can open.
export const Route = createFileRoute("/$locale/_app/storage/")({
  beforeLoad: async ({ params: { locale }, context: { queryClient } }) =>
    redirect(await legacyStorageIndexHref(queryClient), locale),
});
