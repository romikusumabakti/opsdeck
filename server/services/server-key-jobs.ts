import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  type SshKeyJob,
  type SshKeyJobResult,
  servers,
  sshKeyJobs,
  sshKeys,
} from "@/lib/db/schema";
import { enqueue, type JobName, jobExists } from "@/lib/queue";
import {
  beginRotation,
  ensureCurrentKey,
  keyJobLock,
  keyJobLockHeld,
  retireKey,
} from "@/lib/ssh-keys";
import {
  type KeyMoveResult,
  moveServerToKey,
  refuse,
  rotateServerKey,
} from "@/server/services/server-keys";

// --- Key jobs: move all, rotate ----------------------------------------------
//
// One job at a time across both kinds (a move-all during a rotation could
// install the old key), made durable twice: ssh_key_jobs allows one open row
// (a unique index), and the worker holds the key-job advisory lock for the
// whole run. Servers are handled one at a time: each holds a pooled
// connection for its lock over the whole SSH exchange, and the pool is small.

export type KeyJobKind = SshKeyJob["kind"];

const KEY_JOB_NAMES = {
  moveAll: "server-key-move-all",
  rotate: "server-key-rotate",
} as const satisfies Record<KeyJobKind, JobName>;

/** Why a key job stopped before it ran out (the Panel restarted, or a bug). */
const JOB_INTERRUPTED = "keyJobInterrupted";

async function finishKeyJob(keyJobId: string, errorCode: string | null) {
  await db
    .update(sshKeyJobs)
    .set({ finishedAt: new Date(), errorCode })
    .where(and(eq(sshKeyJobs.id, keyJobId), isNull(sshKeyJobs.finishedAt)));
}

/**
 * Close the open job when nothing runs it any more: started but its worker no
 * longer holds the lock (the process died), or never started and gone from
 * the queue. The lock is checked after the row is read, and a worker sets
 * started_at only while holding it, so a live job is never closed.
 */
async function closeAbandonedKeyJob() {
  const [open] = await db
    .select({ id: sshKeyJobs.id, startedAt: sshKeyJobs.startedAt })
    .from(sshKeyJobs)
    .where(isNull(sshKeyJobs.finishedAt))
    .limit(1);
  if (!open) return;
  if (await keyJobLockHeld()) return;
  if (open.startedAt === null && (await jobExists(open.id))) return;
  console.error(`ssh key job ${open.id} was abandoned; closing it`);
  await finishKeyJob(open.id, JOB_INTERRUPTED);
}

async function requestKeyJob(kind: KeyJobKind): Promise<{ queued: true }> {
  const session = await requireOrgPermission({ server: ["manage"] });
  await closeAbandonedKeyJob();
  const [job] = await db
    .insert(sshKeyJobs)
    .values({ kind, actorId: session.user.id })
    .onConflictDoNothing()
    .returning({ id: sshKeyJobs.id });
  if (!job) return refuse("keyJobRunning");
  try {
    await enqueue(KEY_JOB_NAMES[kind], { keyJobId: job.id }, { jobId: job.id });
  } catch (error) {
    await finishKeyJob(job.id, JOB_INTERRUPTED);
    throw error;
  }
  return { queued: true };
}

/** Queue "Move all servers to the SSH key" (org server:manage). */
export function requestMoveAll(): Promise<{ queued: true }> {
  return requestKeyJob("moveAll");
}

/** Queue "Rotate the SSH key" (org server:manage). */
export function requestRotate(): Promise<{ queued: true }> {
  return requestKeyJob("rotate");
}

type Report = (result: SshKeyJobResult) => Promise<void>;

async function moveAll(actorId: string, job: string, report: Report) {
  const rows = await db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .where(eq(servers.auth, "password"))
    .orderBy(asc(servers.name));
  for (const server of rows) {
    let result: KeyMoveResult;
    try {
      result = await moveServerToKey(server.id, actorId, { job });
    } catch (error) {
      // Deleted meanwhile, or a database error: this server only.
      console.error(
        `move all: server ${server.id} failed:`,
        (error as Error).message
      );
      result = { ok: false, code: "keyInstallFailed" };
    }
    await report({
      serverId: server.id,
      name: server.name,
      ok: result.ok,
      code: result.ok ? null : result.code,
    });
  }
}

/**
 * Every key server, including those already on the new key: a server's row
 * says which key it signs in with, not that the old key's line is gone from
 * its file (a failed removal, or a reinstall), so each is checked. The old key
 * is retired only when every server ended clean in this run and no row still
 * names it.
 */
async function rotate(actorId: string, job: string, report: Report) {
  const { current, previous } = await beginRotation();
  const rows = await db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .where(eq(servers.auth, "key"))
    .orderBy(asc(servers.name));
  let allClean = true;
  for (const server of rows) {
    let result: KeyMoveResult | null;
    try {
      result = await rotateServerKey(
        server.id,
        actorId,
        current,
        previous.id,
        job
      );
    } catch (error) {
      console.error(
        `rotate: server ${server.id} failed:`,
        (error as Error).message
      );
      result = { ok: false, code: "keyInstallFailed" };
    }
    if (result === null) continue;
    if (!result.ok) allClean = false;
    await report({
      serverId: server.id,
      name: server.name,
      ok: result.ok,
      code: result.ok ? null : result.code,
    });
  }
  if (allClean) await retireKey(previous.id);
}

/**
 * The worker side of a key job. Results are written after every server, so
 * GET /api/instance/ssh-key shows progress and, after a restart, the last
 * outcome. A job already closed (abandoned, then picked up late) is skipped.
 * A redelivery (its worker died) keeps the results recorded so far; one that
 * finds the job lock taken (the first delivery still runs) leaves the row to
 * it.
 */
export async function runKeyJob(
  kind: KeyJobKind,
  keyJobId: string
): Promise<{ status: "done" | "skipped" | "keyJobRunning" }> {
  const [job] = await db
    .select()
    .from(sshKeyJobs)
    .where(eq(sshKeyJobs.id, keyJobId))
    .limit(1);
  if (!job || job.finishedAt !== null || job.kind !== kind) {
    return { status: "skipped" };
  }
  const release = await keyJobLock();
  if (!release) return { status: "keyJobRunning" };
  try {
    const started = await db
      .update(sshKeyJobs)
      .set({ startedAt: job.startedAt ?? new Date() })
      .where(and(eq(sshKeyJobs.id, keyJobId), isNull(sshKeyJobs.finishedAt)))
      .returning({ results: sshKeyJobs.results });
    if (started.length === 0) return { status: "skipped" };

    // One entry per server: a server handled again replaces its entry.
    const results: SshKeyJobResult[] = [...(started[0]?.results ?? [])];
    const report: Report = async (result) => {
      const at = results.findIndex((r) => r.serverId === result.serverId);
      if (at === -1) results.push(result);
      else results[at] = result;
      await db
        .update(sshKeyJobs)
        .set({ results: [...results] })
        .where(eq(sshKeyJobs.id, keyJobId));
    };
    const actorId = job.actorId ?? "system";
    let errorCode: string | null = null;
    try {
      await (kind === "moveAll" ? moveAll : rotate)(actorId, keyJobId, report);
    } catch (error) {
      console.error(
        `ssh key job ${keyJobId} failed:`,
        (error as Error).message
      );
      errorCode = JOB_INTERRUPTED;
    }
    await finishKeyJob(keyJobId, errorCode);
    return { status: "done" };
  } finally {
    await release().catch(() =>
      console.error("ssh key job lock release failed")
    );
  }
}

export type InstanceSshKey = {
  publicKey: string;
  fingerprint: string;
  previous?: { fingerprint: string };
  lastJob: {
    kind: KeyJobKind;
    requestedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    results: SshKeyJobResult[];
    errorCode: string | null;
  } | null;
};

/** The instance key, a rotation left unfinished, and the last key job. */
export async function getInstanceSshKey(): Promise<InstanceSshKey> {
  await requireOrgPermission({ server: ["manage"] });
  // The page polls this: a job nothing runs any more must not show as running.
  await closeAbandonedKeyJob();
  const current = await ensureCurrentKey();
  const [previous] = await db
    .select({ fingerprint: sshKeys.fingerprint })
    .from(sshKeys)
    .where(eq(sshKeys.status, "previous"))
    .limit(1);
  const [job] = await db
    .select()
    .from(sshKeyJobs)
    .orderBy(desc(sshKeyJobs.requestedAt))
    .limit(1);
  return {
    publicKey: current.publicKey,
    fingerprint: current.fingerprint,
    ...(previous ? { previous: { fingerprint: previous.fingerprint } } : {}),
    lastJob: job
      ? {
          kind: job.kind,
          requestedAt: job.requestedAt,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          results: job.results,
          errorCode: job.errorCode,
        }
      : null,
  };
}
