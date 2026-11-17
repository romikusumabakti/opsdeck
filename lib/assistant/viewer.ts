import { resolveProjectAccess } from "@/lib/authz";
import { db } from "@/lib/db";
import { canOrg, normalizeOrgRole, type OrgRole } from "@/lib/permissions";

/**
 * Who an assistant job runs for. The worker has no request session, so the
 * session-bound helpers in lib/authz and lib/knowledge cannot be used; this
 * resolves the same rules (resolveProjectAccess, canOrg) from the user's role
 * and memberships in the database, so the two paths cannot drift.
 */
export type AssistantViewer = {
  userId: string;
  orgRole: OrgRole;
  projectIds: "all" | string[];
  canManageKnowledge: boolean;
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

/** Pure: the viewer for a user row plus the project ids it can reach. */
export function buildAssistantViewer(
  user: { id: string; role: string | null },
  allProjectIds: string[],
  memberProjectIds: string[]
): AssistantViewer {
  const access = resolveProjectAccess(
    user.role,
    allProjectIds,
    memberProjectIds
  );
  return {
    userId: user.id,
    orgRole: normalizeOrgRole(user.role),
    projectIds: access.all ? "all" : Object.keys(access.roles),
    canManageKnowledge: canOrg(user.role, { knowledge: ["manage"] }),
  };
}

/** A ban without an expiry, or one that has not expired yet, is in force. */
function isBanned(user: { banned: boolean; banExpires: Date | null }): boolean {
  if (!user.banned) return false;
  return user.banExpires === null || user.banExpires.getTime() > Date.now();
}

/** Throws AssistantViewerError for an unknown or banned user. */
export async function loadAssistantViewer(
  userId: string
): Promise<AssistantViewer> {
  const user = await db.query.users.findFirst({
    where: { id: userId },
    columns: { id: true, role: true, banned: true, banExpires: true },
  });
  if (!user) throw new AssistantViewerError("User not found", "not_found");
  if (isBanned(user))
    throw new AssistantViewerError("User is banned", "banned");

  const [allProjects, memberships] = await Promise.all([
    db.query.projects.findMany({ columns: { id: true } }),
    db.query.projectMembers.findMany({
      where: { userId },
      columns: { projectId: true },
    }),
  ]);
  return buildAssistantViewer(
    user,
    allProjects.map((p) => p.id),
    memberships.map((m) => m.projectId)
  );
}

/** A project as an automatic question names it to the model. */
export type ProjectEntry = {
  id: string;
  key: string;
  name: string;
  client: string | null;
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
  return db.query.projects.findMany({
    columns: {
      id: true,
      key: true,
      name: true,
      client: true,
      description: true,
    },
    orderBy: { key: "asc" },
  });
}

/** The projects the viewer can see, in the given order. */
export function visibleProjects(
  viewer: AssistantViewer,
  projects: ProjectEntry[]
): ProjectEntry[] {
  return projects.filter((project) => viewerSees(viewer, project.id));
}
