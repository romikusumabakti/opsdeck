import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { legacyStorageConnectionHref } from "./-components/storage-redirect";

// An old file-browser link goes to the same browser under the connection's
// environment, or to Admin › Storage while no environment owns it.
export const Route = createFileRoute("/$locale/_app/storage/$id/files")({
  beforeLoad: async ({ params: { locale, id }, context: { queryClient } }) =>
    redirect(
      await legacyStorageConnectionHref(queryClient, id, "/files"),
      locale
    ),
});
