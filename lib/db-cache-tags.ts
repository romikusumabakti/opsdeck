// Per-project cache tags for the SSH-probed database and backup listings.
// Kept in a plain module (not a "use server" file, where every export must be
// an async action) so both the server actions and a future worker-side
// `revalidateTag` hook can import them. The mutations in actions/databases.ts
// and actions/backups.ts only *enqueue* work, so the listing changes later in
// the worker — that is where an eventual invalidation belongs.

export function dbListCacheTag(projectId: string): string {
  return `db-list:${projectId}`;
}

export function backupListCacheTag(projectId: string): string {
  return `backup-list:${projectId}`;
}
