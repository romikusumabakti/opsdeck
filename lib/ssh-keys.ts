import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { utils } from "ssh2";
import { db, pgClient } from "@/lib/db";
import { sshKeys } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

// The instance's own ed25519 key and the helpers that edit a server's
// authorized_keys without touching lines that are not ours. Server-only: the
// private key never leaves this module except through loadPrivateKey.

export function generateInstanceKey(): {
  publicKey: string;
  privateKeyPem: string;
  fingerprint: string;
} {
  const pair = parseableKeyPair();
  const publicKey = pair.public.trim();
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) throw parsed;
  const blob = Array.isArray(parsed)
    ? parsed[0].getPublicSSH()
    : parsed.getPublicSSH();
  return {
    publicKey,
    privateKeyPem: pair.private,
    fingerprint: sshFingerprint(blob),
  };
}

// ssh2's generator now and then (about 1 in 250, measured under Bun and Node)
// emits an ed25519 private key its own parser rejects as malformed; such a key
// could never sign in, and a rotation to it would fail on every server.
const KEYGEN_ATTEMPTS = 20;

function parseableKeyPair(): { public: string; private: string } {
  for (let attempt = 0; attempt < KEYGEN_ATTEMPTS; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error("could not generate a usable ed25519 key");
}

/** OpenSSH's `SHA256:<base64, unpadded>` fingerprint of a public key blob. */
export function sshFingerprint(blob: Buffer): string {
  const digest = createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/, "");
  return `SHA256:${digest}`;
}

export async function ensureCurrentKey(): Promise<{
  id: string;
  publicKey: string;
  fingerprint: string;
}> {
  const pick = (r: { id: string; publicKey: string; fingerprint: string }) => ({
    id: r.id,
    publicKey: r.publicKey,
    fingerprint: r.fingerprint,
  });
  const find = async () =>
    (
      await db
        .select()
        .from(sshKeys)
        .where(eq(sshKeys.status, "current"))
        .limit(1)
    )[0];

  const existing = await find();
  if (existing) return pick(existing);

  const key = generateInstanceKey();
  // The partial unique index on status = 'current' makes a concurrent insert a
  // no-op; the loser then reads the winner's row.
  const [created] = await db
    .insert(sshKeys)
    .values({
      publicKey: key.publicKey,
      privateKey: encryptSecret(key.privateKeyPem),
      fingerprint: key.fingerprint,
      status: "current",
    })
    .onConflictDoNothing()
    .returning();
  if (created) return pick(created);

  const winner = await find();
  if (!winner)
    throw new Error("ssh key creation raced and no current key exists");
  return pick(winner);
}

export async function loadPrivateKey(keyId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.id, keyId))
    .limit(1);
  if (!row) throw new Error("ssh key not found");
  return decryptSecret(row.privateKey);
}

export function keyMarker(keyId: string): string {
  const configured = process.env.COMPOSE_PROJECT_NAME;
  const instance =
    configured && /^[A-Za-z0-9_.-]+$/.test(configured) ? configured : "opsdeck";
  const marker = `opsdeck:${instance}:${keyId}`;
  if (!/^opsdeck:[A-Za-z0-9_.-]+:[A-Za-z0-9-]+$/.test(marker)) {
    throw new Error("invalid ssh key marker");
  }
  return marker;
}

function isValidFrom(from: string): boolean {
  // isIP accepts IPv6 zone ids ("fe80::1%eth0"), which sshd does not match.
  if (from.includes("%")) return false;
  const [addr = "", prefix, ...rest] = from.split("/");
  if (rest.length > 0) return false;
  const family = isIP(addr);
  if (!family) return false;
  if (prefix === undefined) return true;
  return validPrefix(prefix, family);
}

function validPrefix(prefix: string, family: number): boolean {
  return (
    /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
  );
}

/**
 * The public key restricted to `from`, with the marker as its only comment.
 * Throws on anything that is not a plain key, an IP or IP/prefix, or a marker,
 * so no option can be injected into the line.
 */
export function authorizedKeysLine(
  publicKey: string,
  from: string,
  marker: string
): string {
  const [type, base64] = publicKey.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new Error("invalid public key");
  }
  if (!isValidFrom(from)) throw new Error("invalid from address");
  if (!/^opsdeck:[A-Za-z0-9_.-]+:[A-Za-z0-9-]+$/.test(marker)) {
    throw new Error("invalid ssh key marker");
  }
  return `from="${from}",no-agent-forwarding,no-X11-forwarding ${type} ${base64} ${marker}`;
}

/** Whether an authorized_keys line is ours: its last field is `marker`. */
export function isOurs(line: string, marker: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return false;
  return trimmed.split(/\s+/).at(-1) === marker;
}

// Foreign lines are kept byte for byte (including a trailing \r); only the
// line we write ends in a plain \n.
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function mergeAuthorizedKeys(
  existing: string,
  line: string,
  marker: string
): string {
  const lines = splitLines(existing);
  const at = lines.findIndex((l) => isOurs(l, marker));
  if (at === -1) lines.push(line);
  else {
    lines[at] = line;
    // Drop any further duplicates of our marker.
    for (let i = lines.length - 1; i > at; i--) {
      if (isOurs(lines[i] ?? "", marker)) lines.splice(i, 1);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function removeAuthorizedKey(existing: string, marker: string): string {
  const lines = splitLines(existing).filter((l) => !isOurs(l, marker));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * The address to put in from=: the client address of $SSH_CLIENT, or the
 * instance's own subnet (CIDR) when that address lies inside it, so a
 * container restart that changes the IP does not lock the key out. Returns
 * null when $SSH_CLIENT does not start with an IP address (empty under sudo
 * env_reset, or noise); callers must treat that as a failed install.
 */
export function fromAddress(
  sshClient: string,
  ownSubnet: string | null
): string | null {
  const address = sshClient.trim().split(/\s+/)[0] ?? "";
  const addressFamily = isIP(address);
  if (!addressFamily) return null;
  if (!ownSubnet) return address;
  const [net = "", prefix = "", ...rest] = ownSubnet.split("/");
  const family = isIP(net);
  if (rest.length > 0 || !family || !validPrefix(prefix, family))
    return address;
  const list = new BlockList();
  list.addSubnet(net, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  return list.check(address, addressFamily === 4 ? "ipv4" : "ipv6")
    ? ownSubnet
    : address;
}

/**
 * Class of the per-server key-operation advisory locks: "sshk" as a
 * big-endian int32, in the two-int4 key space (apart from the instance backup
 * lock's "opsd" class and the single-bigint provisioning locks). The object id
 * is Postgres' hashtext of the server id; two servers sharing a hash only
 * serialise, never corrupt.
 */
export const SERVER_KEY_LOCK_CLASS = 1936943211;

/**
 * The lock of the instance's key jobs (move all, rotate): class "sshj", object
 * 0. One lock for both kinds, so a move-all never runs during a rotation.
 */
export const KEY_JOB_LOCK = { classId: 1936943210, objId: 0 };

type Reserved = Awaited<ReturnType<ReturnType<typeof pgClient>["reserve"]>>;

/**
 * A connection whose lock query failed may still hold the lock (the reply may
 * be what was lost), and a dead one must not be handed out again: either way
 * it never goes back to the pool. Ending its session drops every lock with
 * it; postgres.js then reconnects that pool slot on its own.
 */
async function discard(conn: Reserved) {
  try {
    await conn`select pg_terminate_backend(pg_backend_pid())`;
  } catch {
    // Expected: the server ends the session while answering, or it was gone.
  }
}

/**
 * A session-level advisory lock on a reserved connection held for the run, so
 * a crashed process releases it with its connection. Resolves to its release,
 * or to null when another session holds it.
 */
async function sessionLock(
  take: (conn: Reserved) => Promise<{ locked: boolean }[]>,
  drop: (conn: Reserved) => Promise<unknown>
): Promise<(() => Promise<void>) | null> {
  const conn = await pgClient().reserve();
  try {
    const [row] = await take(conn);
    if (!row?.locked) {
      conn.release();
      return null;
    }
  } catch (error) {
    await discard(conn);
    throw error;
  }
  return async () => {
    try {
      await drop(conn);
    } catch (error) {
      await discard(conn);
      throw error;
    }
    conn.release();
  };
}

/**
 * Takes the lock that serialises key operations on one server (move,
 * reinstall, move-all, rotate) across every process. Resolves to its release,
 * or to null when another operation holds it.
 */
export function serverKeyLock(
  serverId: string
): Promise<(() => Promise<void>) | null> {
  return sessionLock(
    (conn) => conn<{ locked: boolean }[]>`
      select pg_try_advisory_lock(
        ${SERVER_KEY_LOCK_CLASS}::int, hashtext(${serverId}::text)
      ) as locked`,
    (conn) => conn`select pg_advisory_unlock(
      ${SERVER_KEY_LOCK_CLASS}::int, hashtext(${serverId}::text)
    )`
  );
}

/**
 * Takes the instance's key-job lock, held by the worker for a whole move-all
 * or rotation. Resolves to its release, or to null when a job holds it.
 */
export function keyJobLock(): Promise<(() => Promise<void>) | null> {
  return sessionLock(
    (conn) => conn<{ locked: boolean }[]>`
      select pg_try_advisory_lock(
        ${KEY_JOB_LOCK.classId}::int, ${KEY_JOB_LOCK.objId}::int
      ) as locked`,
    (conn) => conn`select pg_advisory_unlock(
      ${KEY_JOB_LOCK.classId}::int, ${KEY_JOB_LOCK.objId}::int
    )`
  );
}

/** Whether any session holds the key-job lock (a job is running). */
export async function keyJobLockHeld(): Promise<boolean> {
  const [row] = await pgClient()<{ held: boolean }[]>`
    select exists(
      select 1 from pg_locks
      where locktype = 'advisory' and granted and objsubid = 2
        and classid = ${KEY_JOB_LOCK.classId}::oid
        and objid = ${KEY_JOB_LOCK.objId}::oid
    ) as held`;
  return row?.held === true;
}

// --- Rotation ----------------------------------------------------------------

export type InstanceKey = {
  id: string;
  publicKey: string;
  fingerprint: string;
};

/**
 * The keys a rotation works with. With a `previous` key already there (an
 * earlier rotation left servers on it) that rotation is resumed and no key is
 * generated; otherwise a new key becomes `current` and the old one `previous`,
 * in one transaction (the partial unique index allows one current key).
 */
export async function beginRotation(): Promise<{
  current: InstanceKey;
  previous: InstanceKey;
}> {
  const pick = (r: InstanceKey) => ({
    id: r.id,
    publicKey: r.publicKey,
    fingerprint: r.fingerprint,
  });
  const [unfinished] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.status, "previous"))
    .limit(1);
  if (unfinished) {
    return { current: await ensureCurrentKey(), previous: pick(unfinished) };
  }

  const old = await ensureCurrentKey();
  const key = generateInstanceKey();
  const created = await db.transaction(async (tx) => {
    const demoted = await tx
      .update(sshKeys)
      .set({ status: "previous" })
      .where(and(eq(sshKeys.id, old.id), eq(sshKeys.status, "current")))
      .returning({ id: sshKeys.id });
    if (demoted.length === 0) throw new Error("the current ssh key changed");
    const [row] = await tx
      .insert(sshKeys)
      .values({
        publicKey: key.publicKey,
        privateKey: encryptSecret(key.privateKeyPem),
        fingerprint: key.fingerprint,
        status: "current",
      })
      .returning();
    if (!row) throw new Error("ssh key insert returned nothing");
    return row;
  });
  return { current: pick(created), previous: old };
}

/** Marks a `previous` key `retired`: no server signs in with it any more. */
export async function retireKey(keyId: string): Promise<void> {
  await db
    .update(sshKeys)
    .set({ status: "retired" })
    .where(and(eq(sshKeys.id, keyId), eq(sshKeys.status, "previous")));
}
