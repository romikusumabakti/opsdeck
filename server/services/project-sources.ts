import { eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  deleteProjectService,
  getComponentBranch,
  insertProjectService,
  loadProjectSources,
  type ProjectSource,
  upsertComponentBranch,
} from "@/lib/project-sources";
import { getService, isProjectService } from "@/lib/service-catalog";
import type { ActionResponse } from "@/lib/types";
import { CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// A project's sources are its services (project_services): the services its
// environments may deploy. Reading them is part of the Settings page, which
// needs environment:update; adding or removing a service is an
// environment:create decision, and a hand-set default branch is an
// environment:update one. Only these explicit actions reach the activity
// feed: the automatic add on target insert stays silent.

export async function listProjectSources(
  projectId: string
): Promise<ProjectSource[]> {
  await requireProjectPermission({ projectId }, { environment: ["update"] });
  return loadProjectSources(projectId);
}

async function projectName(projectId: string): Promise<string> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.name ?? "?";
}

export async function addProjectSource(input: {
  projectId: string;
  componentKey: string;
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { environment: ["create"] }
  );
  const t = await getServerTranslator("projectSources");
  if (!(await getService(input.componentKey))) notFound();
  // Only a row that was really added is logged.
  if (await insertProjectService(input.projectId, input.componentKey)) {
    await recordActivity({
      actorId: session.user.id,
      action: "project.sourceAdded",
      entityType: "project",
      entityId: input.projectId,
      data: {
        project: await projectName(input.projectId),
        service: input.componentKey,
      },
    });
  }
  return { success: true, message: t("addedSuccess") };
}

/** 409 sourceInUse while a deploy target of the project uses the service. */
export async function removeProjectSource(input: {
  projectId: string;
  componentKey: string;
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { environment: ["create"] }
  );
  const t = await getServerTranslator("projectSources");
  const outcome = await deleteProjectService(
    input.projectId,
    input.componentKey
  );
  if (outcome === "inUse") {
    const tErr = await getServerTranslator("actionErrors");
    throw new CodedHTTPException(409, "sourceInUse", tErr("sourceInUse"));
  }
  if (outcome === "deleted") {
    await recordActivity({
      actorId: session.user.id,
      action: "project.sourceRemoved",
      entityType: "project",
      entityId: input.projectId,
      data: {
        project: await projectName(input.projectId),
        service: input.componentKey,
      },
    });
  }
  return { success: true, message: t("removedSuccess") };
}

export async function setComponentBranch(input: {
  projectId: string;
  componentKey: string;
  branch: string;
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { environment: ["update"] }
  );
  const t = await getServerTranslator("projectSources");
  if (!(await getService(input.componentKey))) notFound();
  if (!(await isProjectService(input.projectId, input.componentKey))) {
    const tErr = await getServerTranslator("actionErrors");
    throw new CodedHTTPException(
      409,
      "componentNotInSources",
      tErr("componentNotInSources")
    );
  }
  const from = await getComponentBranch(input.projectId, input.componentKey);
  await upsertComponentBranch({ ...input, userId: session.user.id });
  if (from !== input.branch) {
    await recordActivity({
      actorId: session.user.id,
      action: "project.defaultBranchChanged",
      entityType: "project",
      entityId: input.projectId,
      data: {
        project: await projectName(input.projectId),
        component: input.componentKey,
        from: from ?? "",
        to: input.branch,
      },
    });
  }
  return { success: true, message: t("branchSaved") };
}
