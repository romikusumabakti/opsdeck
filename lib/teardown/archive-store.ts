import type { EnvironmentArchive } from "@/lib/db/schema";
import {
  loadBackupDestination,
  loadS3ConnectionStore,
  type ObjectStore,
} from "@/lib/instance-backup/destination";
import { sameS3Bucket } from "@/lib/validation";

// Where an `s3` environment archive's objects are, for the archive steps,
// the download and the prune. Keys are the archive's own (keyPrefix whole).
//
// - Written to the backup destination (in_backup_destination): today's
//   destination, but only while it still points at the endpoint and bucket
//   the archive recorded. Once the setting moved elsewhere, or was removed,
//   the archive is unreachable (null), as an old one whose connection is gone.
// - Written before the backup destination got its own credentials: the S3
//   connection the archive names (s3_connection_id), whatever the setting
//   says; null once that connection is deleted.

export async function loadArchiveStore(
  archive: Pick<
    EnvironmentArchive,
    "inBackupDestination" | "s3Endpoint" | "s3Bucket" | "s3ConnectionId"
  >
): Promise<ObjectStore | null> {
  if (archive.inBackupDestination) {
    if (!archive.s3Endpoint || !archive.s3Bucket) return null;
    const destination = await loadBackupDestination();
    if (
      !destination ||
      !sameS3Bucket(destination, {
        endpoint: archive.s3Endpoint,
        bucket: archive.s3Bucket,
      })
    ) {
      return null;
    }
    return destination.bucketStore;
  }
  return archive.s3ConnectionId
    ? loadS3ConnectionStore(archive.s3ConnectionId)
    : null;
}
