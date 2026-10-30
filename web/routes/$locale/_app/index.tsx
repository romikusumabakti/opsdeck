import { createFileRoute } from "@tanstack/react-router";

// Temporary landing page so sign-in has somewhere to go; Task 8 ports the
// real home page (app/[locale]/(home)) into this file.
export const Route = createFileRoute("/$locale/_app/")({
  component: () => null,
});
