import { createFileRoute } from "@tanstack/react-router";
import { redirectLegacyApp } from "./-components/services/legacy-redirect";

// An app's variable templates moved to each service's page (Stage 8).
export const Route = createFileRoute("/$locale/_app/apps/$appKey/variables")({
  beforeLoad: redirectLegacyApp,
});
