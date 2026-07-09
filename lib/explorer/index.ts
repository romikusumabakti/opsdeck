import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { s3Connections, servers } from "@/lib/db/schema";
import { createS3Backend } from "./s3";
import { createSftpBackend } from "./sftp";
import type { StorageBackend } from "./types";

export type { ExplorerEntry, StorageBackend } from "./types";

// A storage location the explorer browses. Carries only ids — credentials are
// loaded server-side here so they never live in a client payload or job record
// (same discipline as JobMap in lib/queue.ts).
export type ExplorerSource =
  | { kind: "s3"; connectionId: string }
  | { kind: "sftp"; serverId: string };

// Resolve a source to a live backend, loading and injecting credentials from
// the DB. Returns null when the referenced connection/server no longer exists.
// This is the ONLY place credentials are read for the explorer.
export async function resolveBackend(
  source: ExplorerSource
): Promise<StorageBackend | null> {
  if (source.kind === "s3") {
    const [conn] = await db
      .select()
      .from(s3Connections)
      .where(eq(s3Connections.id, source.connectionId))
      .limit(1);
    return conn ? createS3Backend(conn) : null;
  }

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, source.serverId))
    .limit(1);
  if (!server) return null;
  return createSftpBackend(
    {
      host: server.host,
      username: server.username,
      password: server.password,
    },
    server.sftpRoot
  );
}
