import { useSuspenseQuery } from "@tanstack/react-query";
import { listProjectsQuery } from "@/web/api/project-catalog";

/** A project's name by id, from the catalog the app shell already loaded. */
export function useProjectName(projectId: string): string {
  const projects = useSuspenseQuery(listProjectsQuery()).data;
  return projects.find((p) => p.id === projectId)?.name ?? "";
}
