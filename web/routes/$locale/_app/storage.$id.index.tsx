import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { legacyStorageConnectionHref } from "./-components/storage-redirect";

// An old connection link goes to the connection's environment page, or to
// Admin › Storage while no environment owns it.
export const Route = createFileRoute("/$locale/_app/storage/$id/")({
  beforeLoad: async ({ params: { locale, id }, context: { queryClient } }) =>
    redirect(await legacyStorageConnectionHref(queryClient, id, ""), locale),
});
