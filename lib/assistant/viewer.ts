import { asc, eq } from "drizzle-orm";
import {
  type AccessScope,
  AccessScopeError,
  accessScopeForUser,
  scopedProjectIds,
} from "@/lib/access-scope";
import { db } from "@/lib/db";
import { projectGroups, projects } from "@/lib/db/schema";
import { canOrg, type OrgRole } from "@/lib/permissions";

/**
 * Who an assistant job runs for. The worker has no request session, so the
 * session-bound helpers in lib/authz and lib/knowledge cannot be used; the
 * viewer carries the user's AccessScope (lib/access-scope#accessScopeForUser),
 * the same rules a session resolves to, so the two paths cannot drift. Reads
 * that take a scope (the xxxFor service cores) get `scope`.
 */
export type AssistantViewer = {
  userId: string;
  orgRole: OrgRole;
  projectIds: "all" | string[];
  canManageKnowledge: boolean;
  scope: AccessScope;
};

export class AssistantViewerError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "banned"
  ) {
    super(message);
    this.name = "AssistantViewerError";
  }
}

/** Pure: the viewer for a user's access scope. */
export function buildAssistantViewer(scope: AccessScope): AssistantViewer {
  return {
    userId: scope.userId,
    orgRole: scope.orgRole,
    projectIds: scopedProjectIds(scope),
    canManageKnowledge: canOrg(scope.orgRole, { knowledge: ["manage"] }),
    scope,
  };
}

/** Throws AssistantViewerError for an unknown or banned user. */
export async function loadAssistantViewer(
  userId: string
): Promise<AssistantViewer> {
  try {
    return buildAssistantViewer(await accessScopeForUser(userId));
  } catch (error) {
    if (error instanceof AccessScopeError) {
      throw new AssistantViewerError(error.message, error.reason);
    }
    throw error;
  }
}

/** A project as an automatic question names it to the model. */
export type ProjectEntry = {
  id: string;
  key: string;
  name: string;
  group: string | null;
  description: string | null;
};

/** The viewer may still use the assistant on the project (every role that sees it may). */
export function viewerSees(
  viewer: AssistantViewer,
  projectId: string
): boolean {
  return viewer.projectIds === "all" || viewer.projectIds.includes(projectId);
}

/** Every project, ordered by key. Filter with visibleProjects before use. */
export async function loadProjectEntries(): Promise<ProjectEntry[]> {
  return db
    .select({
      id: projects.id,
      key: projects.key,
      name: projects.name,
      group: projectGroups.name,
      description: projects.description,
    })
    .from(projects)
    .leftJoin(projectGroups, eq(projectGroups.id, projects.groupId))
    .orderBy(asc(projects.key));
}

/** The projects the viewer can see, in the given order. */
export function visibleProjects(
  viewer: AssistantViewer,
  projects: ProjectEntry[]
): ProjectEntry[] {
  return projects.filter((project) => viewerSees(viewer, project.id));
}
