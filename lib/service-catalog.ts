import { and, asc, eq } from "drizzle-orm";
import { type DbExecutor, db } from "@/lib/db";
import { appComponents, projectServices } from "@/lib/db/schema";

// The services model (Stage 8): a Service is one app_components row, keyed by
// its component key (the key every deploy target, build, registry image and
// build webhook already uses). The table keeps its old name until the
// contract release; code reads services through this layer. (Not to be
// confused with lib/services.ts: the compose/systemd services on a server.)

/** A service as code outside the CI/notify path sees it: no notify secret. */
export type Service = {
  key: string;
  repoFullName: string;
  ciConnectionId: string;
  ciRepoId: string | null;
  bundleImage: string;
  notifySecretName: string;
  pipelineMode: (typeof appComponents.$inferSelect)["pipelineMode"];
  buildSpec: (typeof appComponents.$inferSelect)["buildSpec"];
  pipelineFileCommits: (typeof appComponents.$inferSelect)["pipelineFileCommits"];
  createdAt: Date;
};

const serviceColumns = {
  key: appComponents.componentKey,
  repoFullName: appComponents.repoFullName,
  ciConnectionId: appComponents.ciConnectionId,
  ciRepoId: appComponents.ciRepoId,
  bundleImage: appComponents.bundleImage,
  notifySecretName: appComponents.notifySecretName,
  pipelineMode: appComponents.pipelineMode,
  buildSpec: appComponents.buildSpec,
  pipelineFileCommits: appComponents.pipelineFileCommits,
  createdAt: appComponents.createdAt,
};

export async function getService(
  key: string,
  executor: DbExecutor = db
): Promise<Service | null> {
  const [row] = await executor
    .select(serviceColumns)
    .from(appComponents)
    .where(eq(appComponents.componentKey, key))
    .limit(1);
  return row ?? null;
}

/** Every registered service, by key. */
export async function listServices(
  executor: DbExecutor = db
): Promise<Service[]> {
  return executor
    .select(serviceColumns)
    .from(appComponents)
    .orderBy(asc(appComponents.componentKey));
}

/** The project's services (its Sources), by key. */
export async function listProjectServices(
  projectId: string,
  executor: DbExecutor = db
): Promise<Service[]> {
  return executor
    .select(serviceColumns)
    .from(projectServices)
    .innerJoin(
      appComponents,
      eq(appComponents.componentKey, projectServices.componentKey)
    )
    .where(eq(projectServices.projectId, projectId))
    .orderBy(asc(appComponents.componentKey));
}

export async function isProjectService(
  projectId: string,
  key: string,
  executor: DbExecutor = db
): Promise<boolean> {
  const rows = await executor
    .select({ key: projectServices.componentKey })
    .from(projectServices)
    .where(
      and(
        eq(projectServices.projectId, projectId),
        eq(projectServices.componentKey, key)
      )
    )
    .limit(1);
  return rows.length > 0;
}
