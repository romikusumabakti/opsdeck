import { eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { getComponent } from "@/lib/apps";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import {
  deleteProjectApp,
  getComponentBranch,
  insertProjectApp,
  loadProjectSources,
  type ProjectSource,
  projectSourceAppIds,
  upsertComponentBranch,
} from "@/lib/project-sources";
import type { ActionResponse } from "@/lib/types";
import { CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// A project's sources are the apps its environments build from. Reading them
// is part of the Settings page, which needs environment:update; adding or
// removing an app is an environment:create decision, and a hand-set default
// branch is an environment:update one. Only these explicit actions reach the
// activity feed: the automatic adds on environment and target inserts stay
// silent.

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

async function appName(appId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: apps.name })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  return row?.name;
}

export async function addProjectSource(input: {
  projectId: string;
  appId: string;
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { environment: ["create"] }
  );
  const t = await getServerTranslator("projectSources");
  const app = await appName(input.appId);
  if (app === undefined) notFound();
  // Only a row that was really added is logged.
  if (await insertProjectApp(input.projectId, input.appId)) {
    await recordActivity({
      actorId: session.user.id,
      action: "project.sourceAdded",
      entityType: "project",
      entityId: input.projectId,
      data: {
        project: await projectName(input.projectId),
        app,
      },
    });
  }
  return { success: true, message: t("addedSuccess") };
}

export async function removeProjectSource(input: {
  projectId: string;
  appId: string;
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { environment: ["create"] }
  );
  const t = await getServerTranslator("projectSources");
  const outcome = await deleteProjectApp(input.projectId, input.appId);
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
        app: (await appName(input.appId)) ?? "?",
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
  const component = await getComponent(input.componentKey);
  if (!component) notFound();
  if (!(await projectSourceAppIds(input.projectId)).includes(component.appId)) {
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
