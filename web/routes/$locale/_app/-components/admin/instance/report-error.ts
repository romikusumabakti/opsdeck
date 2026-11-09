import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/web/api/client";

/** Shows a refused request's message; rethrows a 401 (sign-in is underway). */
export function reportError(error: unknown): void {
  if (error instanceof ApiError && error.status !== 401) {
    toast.error(error.message);
    return;
  }
  throw error;
}

/**
 * Refetches the instance page's queries (backups and updates) after a
 * request the updater acts on, so the pending request and the run's
 * progress show at once.
 */
export function refreshInstance(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ["instance"] });
}
