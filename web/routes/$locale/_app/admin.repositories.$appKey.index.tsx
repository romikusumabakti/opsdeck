import { createFileRoute } from "@tanstack/react-router";
import { redirectLegacyApp } from "./-components/services/legacy-redirect";

// An app's page (before Stage 8): its service, or the Services list.
export const Route = createFileRoute(
  "/$locale/_app/admin/repositories/$appKey/"
)({
  beforeLoad: redirectLegacyApp,
});
