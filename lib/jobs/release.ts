import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { garageSource } from "@/lib/instance-backup/destination";
import type { JobMap } from "@/lib/queue";
import { ArtifactImageError, openArtifactLayer } from "@/lib/registry/artifact";
import {
  packageArtifactLayer,
  ReleasePackageError,
  releaseFileName,
} from "@/lib/releases/package";
import {
  getRelease,
  getReleaseJobSubject,
  markReleaseFailed,
  markReleaseReady,
} from "@/lib/releases/repository";
import { appendRunOutput, completeRun, failRun } from "@/lib/run-progress";

export type PrepareReleaseResult = {
  status: "ready" | "failed" | "already-finished" | "missing";
};

// An expected failure; its message is what the release row and run show.
class ReleaseAborted extends Error {}

const UNEXPECTED_MESSAGE = "Preparing the release failed";

/** The sentence stored on the release for a failure. */
function failureMessage(error: unknown): string {
  if (
    error instanceof ReleaseAborted ||
    error instanceof ArtifactImageError ||
    error instanceof ReleasePackageError
  ) {
    return error.message;
  }
  if (
    error instanceof Error &&
    error.message.includes("not found in the registry")
  ) {
    return "The build's artifact is no longer in the registry";
  }
  return UNEXPECTED_MESSAGE;
}

/**
 * Prepares one release: the artifact layer of its build is read from the
 * registry, packaged (the jar, or the static tree as a zip) into a temp dir,
 * uploaded to the Panel's Garage under a key that never changes, and the row
 * becomes `ready`. Any failure makes it `failed`, which frees its version.
 *
 * Returns rather than throws: the outcome lives in the release row and the
 * run, and the job runs with attempts: 1.
 */
export async function handlePrepareRelease(
  data: JobMap["release/prepare.requested"]
): Promise<PrepareReleaseResult> {
  const { releaseId, runId } = data;
  const release = await getReleaseJobSubject(releaseId);
  if (!release) {
    // Deleted before the job ran.
    await bestEffort("fail the run", () =>
      failRun(runId, "The release no longer exists")
    );
    return { status: "missing" };
  }
  // A duplicate delivery of a release that already has its outcome.
  if (release.status !== "preparing") return { status: "already-finished" };

  let tempDir: string | undefined;
  try {
    const kind = release.targetKind;
    if (kind !== "jar" && kind !== "static") {
      throw new ReleaseAborted("The release's deployment no longer exists");
    }
    const store = garageSource();
    if (!store) throw new ReleaseAborted("Release storage is not configured");

    const fileName = releaseFileName(
      release.componentKey,
      release.version,
      kind
    );
    const objectKey = `releases/${release.projectId}/${release.componentKey}/${release.id}/${fileName}`;
    tempDir = await mkdtemp(join(tmpdir(), "opsdeck-release-"));

    await appendRunOutput(
      runId,
      `Fetching ${release.bundleImage}:${release.tag}`
    );
    const layer = await openArtifactLayer(release.bundleImage, release.tag);
    const packaged = await packageArtifactLayer(
      layer.stream,
      kind,
      tempDir,
      fileName
    );
    await appendRunOutput(
      runId,
      `Packaged ${fileName} (${packaged.sizeBytes} bytes, sha256 ${packaged.sha256})`
    );
    await store.upload(objectKey, packaged.filePath);

    const marked = await markReleaseReady(release.id, {
      objectKey,
      fileName,
      sizeBytes: packaged.sizeBytes,
      sha256: packaged.sha256,
    });
    if (!marked) {
      // Deleted while it was prepared: its row is gone, so the file would be
      // left without one. A row still there was finished by another delivery
      // of this job and owns the same key.
      if (!(await getRelease(release.id))) {
        await bestEffort("remove the orphaned file", () =>
          store.delete([objectKey])
        );
      }
      await bestEffort("append to the run", () =>
        appendRunOutput(runId, "The release changed while it was prepared")
      );
      await bestEffort("complete the run", () => completeRun(runId));
      return { status: "already-finished" };
    }
    await bestEffort("append to the run", () =>
      appendRunOutput(runId, `Stored ${fileName}`)
    );
    await bestEffort("complete the run", () => completeRun(runId));
    return { status: "ready" };
  } catch (error) {
    const message = failureMessage(error);
    const detail = error instanceof Error ? error.message : String(error);
    if (message === UNEXPECTED_MESSAGE) {
      console.error("Release: preparing failed:", detail);
    }
    // The row first: a `preparing` release holds its version.
    await bestEffort("fail the release", () =>
      markReleaseFailed(release.id, message)
    );
    await bestEffort("append to the run", () =>
      appendRunOutput(
        runId,
        message === UNEXPECTED_MESSAGE ? `✗ ${detail}` : message
      )
    );
    await bestEffort("fail the run", () => failRun(runId, message));
    return { status: "failed" };
  } finally {
    if (tempDir) {
      const dir = tempDir;
      await bestEffort("remove the temp dir", () =>
        rm(dir, { recursive: true, force: true })
      );
    }
  }
}

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
