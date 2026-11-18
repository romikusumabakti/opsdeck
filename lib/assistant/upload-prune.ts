import { deleteStaleUnsentUploads, removeStoredUpload } from "./file-store";

/**
 * The hourly prune (job `assistant/uploads.prune`): unsent uploads older
 * than 24 h, rows first, then their objects. Returns how many went.
 */
export async function pruneUnsentUploads(): Promise<number> {
  const keys = await deleteStaleUnsentUploads();
  await Promise.all(keys.map(removeStoredUpload));
  if (keys.length > 0) {
    console.info(`[assistant] pruned ${keys.length} unsent uploads`);
  }
  return keys.length;
}
