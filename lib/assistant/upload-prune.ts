import { deleteStaleTemporaryConversations } from "./conversation-store";
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

/**
 * The hourly prune (job `assistant/temporary.prune`): temporary chats idle
 * for more than 24 h, rows first (messages, drafts and files with them),
 * then their files' objects. Returns how many chats went.
 */
export async function pruneTemporaryConversations(): Promise<number> {
  const { count, storageKeys } = await deleteStaleTemporaryConversations(
    new Date()
  );
  await Promise.all(storageKeys.map(removeStoredUpload));
  if (count > 0) {
    console.info(`[assistant] pruned ${count} temporary chats`);
  }
  return count;
}
