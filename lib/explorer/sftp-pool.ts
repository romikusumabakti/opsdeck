import "server-only";

import { createHash } from "node:crypto";
import { NodeSSH } from "node-ssh";
import type { SFTPWrapper } from "ssh2";

export type SshCreds = { host: string; username: string; password: string };

// An SSH handshake is ~8-10 round trips (version banner, KEXINIT, key exchange,
// NEWKEYS, service request, password auth, channel open, subsystem request)
// plus the server's auth cost, so dialing per operation put ~300ms in front of
// every folder click. Keeping the connection warm between operations collapses
// that to a single SFTP round trip, which is what makes the SFTP explorer feel
// like the S3 one.
//
// Scope: SHORT metadata operations only (readdir/stat/mkdir/rename/unlink).
// Bulk transfers get their own connection — see the comment on openSftp in
// ./sftp — because a multi-GB read saturates the SSH channel window and would
// stall every listing sharing that channel until it finished.

// How long a connection with no active lease stays open. Long enough to cover
// the gaps in a browsing session, short enough that an idle SSH session (often
// authenticated as root) isn't held open indefinitely.
const IDLE_TTL_MS = 60_000;

const CONNECT_OPTIONS = {
  // Fail fast on an unreachable host instead of node-ssh's ~20s default.
  readyTimeout: 5000,
  // Detect a half-open socket (NAT or firewall dropped the flow) rather than
  // handing a caller a connection the kernel still believes is alive.
  keepaliveInterval: 15_000,
  keepaliveCountMax: 3,
} as const;

type PooledConnection = {
  ssh: NodeSSH;
  sftp: SFTPWrapper;
  // Operations currently using the channel. Never closed while this is > 0.
  leases: number;
  idleTimer?: NodeJS.Timeout;
};

// A borrowed channel. `release` is idempotent so a caller can wire it to both
// the "close" and "error" events of a stream without double-decrementing.
export type SftpLease = {
  sftp: SFTPWrapper;
  release: () => void;
};

type Pool = Map<string, Promise<PooledConnection>>;

// Cache the pool on globalThis so Next.js dev hot-reload (which re-evaluates
// this module on every change) reuses the live connections instead of leaking a
// new one per reload. Same rationale as the postgres client in lib/db.
const globalForSftp = globalThis as unknown as { __sftpPool?: Pool };
const pool: Pool = globalForSftp.__sftpPool ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalForSftp.__sftpPool = pool;
}

// The password is part of the key so rotating a server's credentials can never
// hand back a connection authenticated with the old one — the new creds simply
// miss the cache. Hashed to keep plaintext secrets out of map keys.
function poolKey(creds: SshCreds): string {
  return createHash("sha256")
    .update(`${creds.host}\0${creds.username}\0${creds.password}`)
    .digest("hex");
}

// Remove an entry from the pool, but only if it is still the entry we think it
// is — a later dial may already have replaced it.
function evict(key: string, pending: Promise<PooledConnection>): void {
  if (pool.get(key) === pending) pool.delete(key);
}

function close(
  key: string,
  conn: PooledConnection,
  pending: Promise<PooledConnection>
): void {
  clearTimeout(conn.idleTimer);
  evict(key, pending);
  conn.ssh.dispose();
}

function scheduleIdleClose(
  key: string,
  conn: PooledConnection,
  pending: Promise<PooledConnection>
): void {
  clearTimeout(conn.idleTimer);
  if (conn.leases > 0) return;
  conn.idleTimer = setTimeout(() => close(key, conn, pending), IDLE_TTL_MS);
  // Don't keep the process alive for an idle connection (matters for `next
  // build` and for a clean shutdown).
  conn.idleTimer.unref?.();
}

// Synchronous up to `pool.set`, so two concurrent first callers can't both dial:
// the second one finds the in-flight promise.
function acquire(key: string, creds: SshCreds): Promise<PooledConnection> {
  const cached = pool.get(key);
  if (cached) return cached;

  const pending: Promise<PooledConnection> = (async () => {
    const ssh = new NodeSSH();
    await ssh.connect({ ...creds, ...CONNECT_OPTIONS });
    const sftp = await ssh.requestSFTP();
    const conn: PooledConnection = { ssh, sftp, leases: 0 };
    // A connection that dies (server restart, network drop) must not linger in
    // the pool; the next caller should dial a fresh one.
    ssh.connection?.once("close", () => {
      clearTimeout(conn.idleTimer);
      evict(key, pending);
    });
    return conn;
  })();

  // A failed dial must not be cached, or every later call replays the failure.
  pending.catch(() => evict(key, pending));

  pool.set(key, pending);
  return pending;
}

// Returns null when the pooled connection turned out to be dead (and was
// evicted), so the caller can retry on a fresh one. A dial failure throws —
// that is a real connectivity/credential error, not a stale-socket race.
async function take(key: string, creds: SshCreds): Promise<SftpLease | null> {
  const pending = acquire(key, creds);
  const conn = await pending;

  if (!conn.ssh.isConnected()) {
    close(key, conn, pending);
    return null;
  }

  conn.leases++;
  clearTimeout(conn.idleTimer);

  let released = false;
  return {
    sftp: conn.sftp,
    release() {
      if (released) return;
      released = true;
      conn.leases--;
      scheduleIdleClose(key, conn, pending);
    },
  };
}

// Borrow the pooled SFTP channel for `creds`. The caller MUST release it.
export async function leaseSftp(creds: SshCreds): Promise<SftpLease> {
  const key = poolKey(creds);

  const first = await take(key, creds);
  if (first) return first;

  // The pooled connection had already died; `take` evicted it, so this attempt
  // dials fresh. One retry is enough — a second dead connection means a real
  // connectivity problem rather than a socket that went stale while idle.
  const second = await take(key, creds);
  if (second) return second;

  throw new Error("SFTP connection unavailable");
}

// Run a short metadata operation on the pooled channel.
export async function withPooledSftp<T>(
  creds: SshCreds,
  fn: (sftp: SFTPWrapper) => Promise<T>
): Promise<T> {
  const lease = await leaseSftp(creds);
  try {
    return await fn(lease.sftp);
  } finally {
    lease.release();
  }
}

// Open a connection OUTSIDE the pool, for bulk transfers. The caller owns its
// lifetime and must call `dispose`.
export async function openSftp(
  creds: SshCreds
): Promise<{ sftp: SFTPWrapper; dispose: () => void }> {
  const ssh = new NodeSSH();
  await ssh.connect({ ...creds, ...CONNECT_OPTIONS });
  const sftp = await ssh.requestSFTP();
  let disposed = false;
  return {
    sftp,
    dispose() {
      if (disposed) return;
      disposed = true;
      ssh.dispose();
    },
  };
}

// Test-only: drop every pooled connection. Not used by application code.
export function __resetSftpPool(): void {
  for (const pending of pool.values()) {
    pending
      .then((conn) => {
        clearTimeout(conn.idleTimer);
        conn.ssh.dispose();
      })
      .catch(() => {
        // A dial that never succeeded has nothing to dispose.
      });
  }
  pool.clear();
}
