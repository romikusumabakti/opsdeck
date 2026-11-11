import type { Readable } from "node:stream";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission, requireProjectPermission } from "@/lib/authz";
import type { Release } from "@/lib/db/schema";
import { garageSource } from "@/lib/instance-backup/destination";
import { isUniqueViolation } from "@/lib/people/names";
import { enqueue } from "@/lib/queue";
import {
  deleteReleaseRow,
  getRelease,
  getReleaseSource,
  insertReleaseWithRun,
  listProjectReleases,
  markReleaseFailed,
  type ReleaseRow,
  type ReleaseWithProject,
  setReleaseNotes,
} from "@/lib/releases/repository";
import { failRun } from "@/lib/run-progress";
import { uuidSchema } from "@/lib/validation";
import { CodedHTTPException } from "@/server/errors";

// The refusals of the release API, by stable code (server/errors).
export const RELEASE_ERRORS = {
  releaseNotFound: [404, "Release not found"],
  // 400 for a compose target (never a release), else 409.
  releaseSourceInvalid: [
    409,
    "Only a successful deployment of a jar or static target in this environment can become a release",
  ],
  releaseVersionTaken: [
    409,
    "This version is already used by a release of this component",
  ],
  releaseNotReady: [409, "The release is not ready to download"],
  releaseStorageMissing: [503, "Release storage is not configured"],
} as const satisfies Record<string, readonly [404 | 409 | 503, string]>;

function failRelease(
  code: keyof typeof RELEASE_ERRORS,
  status: 400 | 404 | 409 | 503 = RELEASE_ERRORS[code][0]
): never {
  throw new CodedHTTPException(status, code, RELEASE_ERRORS[code][1]);
}

const QUEUE_FAILED_MESSAGE = "Preparing the release could not be queued";

export const releaseVersionSchema = z
  .string()
  .trim()
  .min(1, "Version is required")
  .max(100, "Version must be at most 100 characters")
  .regex(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    /^[^\u0000-\u001f\u007f-\u009f]+$/,
    "Version must not contain control characters"
  );

// Blank notes are stored as none.
export const releaseNotesSchema = z
  .string()
  .trim()
  .max(2000, "Notes must be at most 2000 characters")
  .nullable()
  .transform((notes) => notes || null);

export const createReleaseSchema = z
  .object({
    deploymentId: uuidSchema,
    version: releaseVersionSchema,
    notes: releaseNotesSchema.optional(),
  })
  .strict();

export const updateReleaseNotesSchema = z
  .object({ notes: releaseNotesSchema })
  .strict();

async function bestEffort(
  label: string,
  fn: () => Promise<unknown>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`Release: could not ${label}:`, error);
  }
}

function auditData(release: {
  projectName: string;
  componentKey: string;
  version: string;
}) {
  return {
    project: release.projectName,
    component: release.componentKey,
    version: release.version,
  };
}

async function requireRelease(id: string): Promise<ReleaseWithProject> {
  if (!uuidSchema.safeParse(id).success) failRelease("releaseNotFound");
  return (await getRelease(id)) ?? failRelease("releaseNotFound");
}

/**
 * Marks a successful jar/static deployment of the environment as a release.
 * The row starts `preparing`; the release/prepare job copies the artifact
 * into Garage and makes it `ready` (lib/jobs/release).
 */
export async function createRelease(
  environmentId: string,
  input: { deploymentId: string; version: string; notes?: string | null }
): Promise<{ releaseId: string; runId: string }> {
  const { session, projectId } = await requireProjectPermission(
    { environmentId },
    { release: ["create"] }
  );
  const source = await getReleaseSource(input.deploymentId);
  if (!source || source.environmentId !== environmentId) {
    failRelease("releaseSourceInvalid");
  }
  if (source.targetKind !== "jar" && source.targetKind !== "static") {
    failRelease("releaseSourceInvalid", 400);
  }
  // No build row: the source commit is unknown, so the release could not
  // say what it contains.
  if (source.status !== "success" || !source.branch || !source.commitSha) {
    failRelease("releaseSourceInvalid");
  }

  let created: { releaseId: string; runId: string };
  try {
    created = await insertReleaseWithRun(
      {
        projectId,
        componentKey: source.componentKey,
        environmentId,
        environmentName: source.environmentName,
        deploymentId: source.deploymentId,
        branch: source.branch,
        tag: source.tag,
        commitSha: source.commitSha,
        version: input.version,
        notes: input.notes ?? null,
        createdBy: session.user.id,
      },
      {
        environmentId,
        userId: session.user.id,
        description: `Release ${source.componentKey} ${input.version}`,
        kind: "release",
      }
    );
  } catch (error) {
    if (isUniqueViolation(error)) failRelease("releaseVersionTaken");
    throw error;
  }

  try {
    await enqueue("release/prepare.requested", created);
  } catch (error) {
    // Otherwise the release would stay `preparing` and hold its version.
    await bestEffort("fail the release", () =>
      markReleaseFailed(created.releaseId, QUEUE_FAILED_MESSAGE)
    );
    await bestEffort("fail the run", () =>
      failRun(created.runId, QUEUE_FAILED_MESSAGE)
    );
    throw error;
  }

  await recordActivity({
    actorId: session.user.id,
    action: "release.created",
    entityType: "project",
    entityId: projectId,
    data: auditData({
      projectName: source.projectName,
      componentKey: source.componentKey,
      version: input.version,
    }),
  });
  return created;
}

/** The project's releases, newest first, and the bytes they store. */
export async function listReleases(
  projectId: string
): Promise<{ releases: ReleaseRow[]; totalBytes: number }> {
  await requireProjectPermission({ projectId }, { deploy: ["view"] });
  const releases = await listProjectReleases(projectId);
  const totalBytes = releases.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
  return { releases, totalBytes };
}

/** Notes are the only field of a release that may change. */
export async function updateReleaseNotes(
  id: string,
  notes: string | null
): Promise<Release> {
  const release = await requireRelease(id);
  await requireProjectPermission(
    { projectId: release.projectId },
    { release: ["create"] }
  );
  return (await setReleaseNotes(id, notes)) ?? failRelease("releaseNotFound");
}

/**
 * Deletes a release and its stored file (admins only). The file goes first:
 * if it cannot be deleted the row stays, so no file is left without a row.
 */
export async function deleteRelease(id: string): Promise<void> {
  const session = await requireOrgPermission({ server: ["manage"] });
  const release = await requireRelease(id);
  if (release.objectKey) {
    const store = garageSource() ?? failRelease("releaseStorageMissing");
    await store.delete([release.objectKey]);
  }
  await deleteReleaseRow(id);
  await recordActivity({
    actorId: session.user.id,
    action: "release.deleted",
    entityType: "project",
    entityId: release.projectId,
    data: auditData(release),
  });
}

/** The stored file of a `ready` release, as a stream (engineers only). */
export async function openReleaseDownload(
  id: string
): Promise<{ stream: Readable; fileName: string; sizeBytes: number }> {
  const release = await requireRelease(id);
  const { session } = await requireProjectPermission(
    { projectId: release.projectId },
    { release: ["download"] }
  );
  const { objectKey, fileName, sizeBytes } = release;
  if (
    release.status !== "ready" ||
    !objectKey ||
    !fileName ||
    sizeBytes === null
  ) {
    failRelease("releaseNotReady");
  }
  const store = garageSource() ?? failRelease("releaseStorageMissing");
  const stream = await store.read(objectKey);
  await recordActivity({
    actorId: session.user.id,
    action: "release.downloaded",
    entityType: "project",
    entityId: release.projectId,
    data: auditData(release),
  });
  return { stream, fileName, sizeBytes };
}
