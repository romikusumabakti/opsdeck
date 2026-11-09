import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import type { NodeSSH } from "node-ssh";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { type Server, servers, sshKeys } from "@/lib/db/schema";
import { decryptNullable } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import { openSsh } from "@/lib/ssh";
import {
  HostKeyMismatchError,
  type SshTarget,
  sshTarget,
  trustOfferedHostKey,
} from "@/lib/ssh-connect";
import {
  authorizedKeysLine,
  dropOtherInstanceKeys,
  ensureCurrentKey,
  fromAddress,
  fromOfLine,
  type InstanceKey,
  installCommand,
  instanceKey,
  isOurs,
  isValidFrom,
  KEY_NOT_VERIFIED,
  keyMarker,
  MIN_FROM_PREFIX,
  mergeAuthorizedKeys,
  ownKeyMarkers,
  removeAuthorizedKey,
  serverKeyLock,
} from "@/lib/ssh-keys";
import { CodedHTTPException } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// Moving a server from its stored password to the instance key, on production
// servers, so every step either finishes or puts things back:
//   1. take the server's key-operation lock (one move, reinstall or job at a
//      time per server, across processes);
//   2. sign in with the password (host key verified or pinned);
//   3. a non-root login must have NOPASSWD sudo, or the move stops here;
//   4. write our line into the login user's ~/.ssh/authorized_keys, replacing
//      the file atomically and leaving every other byte of it as it was;
//   5. prove a fresh login with the key alone;
//   6. only then forget the password. A failed proof restores the line we
//      replaced (or removes ours), and the password stays.
// The password, the private key and the file's content are never logged,
// stored in key_error or returned.

export type KeyMoveCode =
  | "keyJobRunning"
  | "noPassword"
  | "unreachable"
  | "passwordRejected"
  | "hostKeyMismatch"
  | "sudoNeedsPassword"
  | "sshDirUnsafe"
  | "keyInstallFailed"
  | "keyLoginFailed"
  | "oldKeyNotRemoved";

export type KeyMoveResult = { ok: true } | { ok: false; code: KeyMoveCode };

// What the admin got wrong (or another run holding the lock), not a state of
// the server: these are answered but not kept in key_error. passwordRejected
// covers the stored password too: a plain move (or move-all) whose stored
// password the server rejects keeps the key_error it had.
const NOT_RECORDED: ReadonlySet<KeyMoveCode> = new Set([
  "keyJobRunning",
  "noPassword",
  "passwordRejected",
]);

const SSH_TUNING = { readyTimeout: 10_000 };
const COMMAND_TIMEOUT_MS = 15_000;

// The login user's authorized_keys, as POSIX sh run through `sh -c` (the
// login shell may not be sh). Both scripts refuse a symlinked ~/.ssh or file
// (writing through one would edit a file elsewhere on the host), and a ~/.ssh
// that sshd's StrictModes would reject anyway: owned by someone other than
// the user or root, or writable by group or others.
const KEYS_PATHS = `case "$HOME" in /*) ;; *) exit 20 ;; esac
d="$HOME/.ssh"; f="$d/authorized_keys"`;

const DIR_SAFE = `o=$(stat -c %u "$d") || exit 22
if [ "$o" != "$(id -u)" ] && [ "$o" != 0 ]; then exit 24; fi
m=$(stat -c %a "$d") || exit 22
if [ $(( 0$m & 022 )) -ne 0 ]; then exit 24; fi`;

// Prints the file as base64 (nothing when missing), so its bytes cross the
// wire untouched; creates ~/.ssh 0700 when missing.
const READ_SCRIPT = `${KEYS_PATHS}
if [ -L "$d" ]; then exit 21; fi
if [ ! -e "$d" ]; then mkdir -m 700 "$d" || exit 22; fi
if [ ! -d "$d" ] || [ -L "$f" ]; then exit 21; fi
${DIR_SAFE}
if [ ! -e "$f" ]; then exit 0; fi
if [ ! -f "$f" ]; then exit 21; fi
base64 < "$f"`;

// Replaces the file with stdin (base64): a temp file in ~/.ssh (same
// filesystem, so the rename is atomic), mode 0600, the old owner kept where we
// may, then renamed over the file.
const WRITE_SCRIPT = `${KEYS_PATHS}
if [ -L "$d" ] || [ ! -d "$d" ] || [ -L "$f" ]; then exit 21; fi
if [ -e "$f" ] && [ ! -f "$f" ]; then exit 21; fi
${DIR_SAFE}
t=$(mktemp "$d/.authorized_keys.opsdeck.XXXXXX") || exit 23
if ! { base64 -d > "$t" && chmod 600 "$t"; }; then rm -f "$t"; exit 23; fi
if [ -e "$f" ]; then chown "$(stat -c %u:%g "$f")" "$t" 2>/dev/null; fi
mv -f "$t" "$f" || { rm -f "$t"; exit 23; }
if command -v restorecon >/dev/null 2>&1; then restorecon "$f" 2>/dev/null; fi
exit 0`;

const EXIT_UNSAFE_DIR = 24;

class StepFailed extends Error {
  constructor(
    readonly code: KeyMoveCode,
    step: string
  ) {
    super(`${step} failed`);
  }
}

type ExecResult = { code: number | null; stdout: string };

async function exec(
  ssh: NodeSSH,
  script: string,
  stdin?: string
): Promise<ExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ssh.execCommand(`sh -c ${shq(script)}`, {
        noTrim: true,
        ...(stdin === undefined ? {} : { stdin }),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("remote command timed out")),
          COMMAND_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a sign-in failed, as a code (the error itself may name the host).
 * `proving`: a key login just after a working session, where any failure
 * means the key was not accepted.
 */
function connectFailure(
  error: unknown,
  auth: "password" | "key",
  proving = auth === "key"
): KeyMoveCode {
  if (error instanceof HostKeyMismatchError) return "hostKeyMismatch";
  const level = (error as { level?: unknown } | null)?.level;
  if (level === "client-authentication") {
    return auth === "password" ? "passwordRejected" : "keyLoginFailed";
  }
  return proving ? "keyLoginFailed" : "unreachable";
}

function scriptFailure(code: number | null, step: string): StepFailed {
  console.error(`authorized_keys ${step} refused (exit ${code})`);
  return new StepFailed(
    code === EXIT_UNSAFE_DIR ? "sshDirUnsafe" : "keyInstallFailed",
    `${step} authorized_keys`
  );
}

// The file travels as base64 and is handled as latin1, which maps each byte
// to one character and back: foreign lines (any encoding, even a broken
// multibyte sequence) are written back byte for byte.
async function readAuthorizedKeys(ssh: NodeSSH): Promise<string> {
  const result = await exec(ssh, READ_SCRIPT);
  if (result.code !== 0) throw scriptFailure(result.code, "read");
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString(
    "latin1"
  );
}

async function writeAuthorizedKeys(ssh: NodeSSH, content: string) {
  const encoded = Buffer.from(content, "latin1").toString("base64");
  const result = await exec(ssh, WRITE_SCRIPT, encoded);
  if (result.code !== 0) throw scriptFailure(result.code, "write");
}

/** Our line as it was before the install, if there was one. */
function previousLine(existing: string, marker: string): string | null {
  const line = existing.split("\n").find((l) => isOurs(l, marker));
  return line === undefined ? null : line.replace(/\r$/, "");
}

type DroppedLine = { marker: string; line: string };

/**
 * Put back what was there before our write: the previous line with our marker
 * (or none), and the lines of our other keys the write dropped (a server whose
 * row still names such a key signs in with it). Re-reads the file so a
 * concurrent edit to other lines survives.
 */
async function rollback(
  ssh: NodeSSH,
  marker: string,
  previous: string | null,
  dropped: readonly DroppedLine[]
) {
  try {
    let content = await readAuthorizedKeys(ssh);
    content =
      previous === null
        ? removeAuthorizedKey(content, marker)
        : mergeAuthorizedKeys(content, previous, marker);
    for (const d of dropped) {
      content = mergeAuthorizedKeys(content, d.line, d.marker);
    }
    await writeAuthorizedKeys(ssh, content);
  } catch {
    console.error("authorized_keys rollback failed; the password is kept");
  }
}

/**
 * Who connections are made as: the admin for their own action; "system" and
 * the job for a background job, so a host key pinned on the way is recorded
 * for that run (the admin stays the actor of the key activity itself).
 */
type ConnectAs = { actor: string; job?: string };

function connectAs(actorId: string, job: string | undefined): ConnectAs {
  return job === undefined ? { actor: actorId } : { actor: "system", job };
}

async function proveKeyLogin(
  target: SshTarget,
  keyId: string,
  as: ConnectAs
): Promise<KeyMoveCode | null> {
  let ssh: NodeSSH | undefined;
  try {
    ssh = await openSsh(target, SSH_TUNING, { keyOnly: true, keyId, ...as });
    const result = await exec(ssh, "true");
    return result.code === 0 ? null : "keyLoginFailed";
  } catch (error) {
    return connectFailure(error, "key");
  } finally {
    ssh?.dispose();
  }
}

/** The activity actor for a user id or "system" (a job whose admin is gone). */
function activityActor(actorId: string): string | null {
  return actorId === "system" ? null : actorId;
}

/**
 * Write our line with `marker`, dropping the lines of our other keys (`ours`)
 * not in `keep` (besides `marker`). Returns what an undo puts back.
 */
async function installLine(
  ssh: NodeSSH,
  existing: string,
  line: string,
  marker: string,
  keep: readonly string[],
  ours: readonly string[]
): Promise<DroppedLine[]> {
  const { content, dropped } = dropOtherInstanceKeys(
    mergeAuthorizedKeys(existing, line, marker),
    [marker, ...keep],
    ours
  );
  await writeAuthorizedKeys(ssh, content);
  return dropped;
}

/** Whether the row already signs in with `keyId` and holds no password. */
async function committedTo(serverId: string, keyId: string): Promise<boolean> {
  const [row] = await db
    .select({
      auth: servers.auth,
      sshKeyId: servers.sshKeyId,
      password: servers.password,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return row?.auth === "key" && row.sshKeyId === keyId && row.password === null;
}

/**
 * Install the instance key on a server and switch it to key login. With
 * `passwordOnce` (reinstall), that password signs in instead of the stored one
 * and is never stored. Answers `keyJobRunning` while another key operation on
 * the server holds its lock, or when a rotation replaced the key it installed
 * before the move committed. The caller checks `server:manage`; jobs call
 * this too, with `job` (their ssh_key_jobs id).
 */
export async function moveServerToKey(
  serverId: string,
  actorId: string,
  opts: { passwordOnce?: string; job?: string } = {}
): Promise<KeyMoveResult> {
  const release = await serverKeyLock(serverId);
  if (!release) return { ok: false, code: "keyJobRunning" };
  try {
    return await moveLocked(serverId, actorId, opts);
  } finally {
    await release().catch(() =>
      console.error(`server key lock release failed for ${serverId}`)
    );
  }
}

async function moveLocked(
  serverId: string,
  actorId: string,
  opts: { passwordOnce?: string; job?: string }
): Promise<KeyMoveResult> {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) throw new Error("server not found");

  const fail = async (code: KeyMoveCode): Promise<KeyMoveResult> => {
    if (!NOT_RECORDED.has(code)) {
      await db
        .update(servers)
        .set({ keyError: code, updatedAt: new Date() })
        .where(eq(servers.id, serverId));
    }
    return { ok: false, code };
  };
  const password = opts.passwordOnce ?? decryptNullable(server.password);
  if (!password) return fail("noPassword");

  const key = await ensureCurrentKey();
  const marker = keyMarker(key.id);
  // A key server being reinstalled still signs in with the typed password.
  const target = sshTarget({ ...server, password, auth: "password" });
  const as = connectAs(actorId, opts.job);

  let ssh: NodeSSH;
  try {
    ssh = await openSsh(target, SSH_TUNING, { passwordOnce: password, ...as });
  } catch (error) {
    return fail(connectFailure(error, "password"));
  }

  let from: string;
  try {
    if (server.username !== "root") {
      const sudo = await exec(ssh, "sudo -n true");
      if (sudo.code !== 0) return fail("sudoNeedsPassword");
    }

    const sshClient = (await exec(ssh, "printf '%s' \"$SSH_CLIENT\"")).stdout;
    const address = fromAddress(sshClient, ownSubnet());
    if (address === null) {
      console.error(`move to key: no usable $SSH_CLIENT on server ${serverId}`);
      return fail("keyInstallFailed");
    }
    from = address;
    let line: string;
    try {
      line = authorizedKeysLine(key.publicKey, from, marker);
    } catch (error) {
      console.error(`move to key: ${(error as Error).message}`);
      return fail("keyInstallFailed");
    }

    const existing = await readAuthorizedKeys(ssh);
    const previous = previousLine(existing, marker);
    // A write drops the lines of our other keys (a key retired or leaked must
    // not keep signing in); an undo puts them back. The line of the key the
    // row signs in with now stays until the commit (a reinstall during a
    // rotation): if anything fails, the server keeps a way in.
    const ours = await ownKeyMarkers(server);
    const rowKey =
      server.auth === "key" && server.sshKeyId && server.sshKeyId !== key.id
        ? [keyMarker(server.sshKeyId)]
        : [];
    let dropped: DroppedLine[] = dropOtherInstanceKeys(
      existing,
      [marker, ...rowKey],
      ours
    ).dropped;
    // Removing our line is only safe while no run has committed the server to
    // this key: then the line is the only way in.
    const undo = async () => {
      if (previous === null && (await committedTo(serverId, key.id))) {
        console.error(
          `server ${serverId} already uses this key; its line is kept`
        );
        return;
      }
      await rollback(ssh, marker, previous, dropped);
    };
    try {
      dropped = await installLine(ssh, existing, line, marker, rowKey, ours);
    } catch (error) {
      // A write cut off by the timeout may still have landed.
      await undo();
      throw error;
    }

    const loginFailure = await proveKeyLogin(
      sshTarget({ ...server, password: null }),
      key.id,
      as
    );
    if (loginFailure) {
      await undo();
      return fail(loginFailure);
    }

    let committed: KeyMoveCode | null;
    try {
      committed = await commitMove(server, key.id, from);
    } catch (error) {
      // A database error: the row is as it was (the undo's guard checks).
      await undo();
      throw error;
    }
    if (committed !== null) {
      await undo();
      return fail(committed);
    }
    // Committed: the row's old key goes too. A failure only leaves a line a
    // later rotation removes.
    if (rowKey.length > 0 && !(await keepOnly(ssh, server, marker))) {
      console.error(`move to key: old line kept on server ${serverId}`);
    }
  } catch (error) {
    if (error instanceof StepFailed) return fail(error.code);
    console.error(
      `move to key failed on server ${serverId}:`,
      (error as Error).message
    );
    return fail("keyInstallFailed");
  } finally {
    ssh.dispose();
  }

  // Committed: nothing after this point may turn the move into a failure.
  try {
    await recordActivity({
      actorId: activityActor(actorId),
      action:
        opts.passwordOnce === undefined
          ? "server.keyInstalled"
          : "server.keyReinstalled",
      entityType: "server",
      entityId: serverId,
      data: { server: server.name, from },
    });
  } catch {
    console.error(`move to key: activity not recorded for server ${serverId}`);
  }
  return { ok: true };
}

/**
 * Switch the row to key login, or answer why not. In one transaction that
 * holds the key row (FOR SHARE), so a rotation cannot demote the key between
 * the check and the update: a key no longer current means a rotation took
 * over (keyJobRunning), and installing it would leave the server on a key
 * being retired. Conditional on the address and login too: a server edited
 * meanwhile is another machine or account, and the key proven here says
 * nothing about it. (Servers have no port column; every server is on 22.)
 */
async function commitMove(
  server: { id: string; host: string; username: string },
  keyId: string,
  from: string
): Promise<KeyMoveCode | null> {
  return db.transaction(async (tx) => {
    const [key] = await tx
      .select({ status: sshKeys.status })
      .from(sshKeys)
      .where(eq(sshKeys.id, keyId))
      .for("share");
    if (key?.status !== "current") return "keyJobRunning";
    const switched = await tx
      .update(servers)
      .set({
        auth: "key",
        sshKeyId: keyId,
        sshFrom: from,
        password: null,
        keyError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(servers.id, server.id),
          eq(servers.host, server.host),
          eq(servers.username, server.username)
        )
      )
      .returning({ id: servers.id });
    return switched.length === 0 ? "keyInstallFailed" : null;
  });
}

// --- Rotation, one server ---------------------------------------------------

/**
 * Move a key server from the key it signs in with to `key`: add the new line
 * next to the old one, prove a login with the new key alone, point the row at
 * it, then remove every other line of this instance. A failed proof removes
 * the new line and keeps the old one. A server already on `key` is signed in
 * with it and only cleaned of other lines. Until the old line is gone the
 * server is not done (`oldKeyNotRemoved`), so its key is not retired.
 * Failures are answered, not kept in key_error: the server still signs in.
 * Null when there is nothing to rotate (the server is gone or on a password).
 */
export async function rotateServerKey(
  serverId: string,
  actorId: string,
  key: InstanceKey,
  previousKeyId: string,
  job?: string
): Promise<KeyMoveResult | null> {
  const release = await serverKeyLock(serverId);
  if (!release) return { ok: false, code: "keyJobRunning" };
  try {
    return await rotateLocked(
      serverId,
      key,
      previousKeyId,
      actorId,
      connectAs(actorId, job)
    );
  } finally {
    await release().catch(() =>
      console.error(`server key lock release failed for ${serverId}`)
    );
  }
}

/**
 * Drop the lines of our keys but `marker`'s (and those another row on the
 * same login uses); false if that failed.
 */
async function keepOnly(
  ssh: NodeSSH,
  server: Server,
  marker: string
): Promise<boolean> {
  try {
    const current = await readAuthorizedKeys(ssh);
    const { content, dropped } = dropOtherInstanceKeys(
      current,
      [marker],
      await ownKeyMarkers(server)
    );
    if (dropped.length > 0) await writeAuthorizedKeys(ssh, content);
    return true;
  } catch {
    return false;
  }
}

/** A server already on `key`: sign in with it and drop any other line. */
async function cleanLocked(
  server: Server,
  key: InstanceKey,
  as: ConnectAs
): Promise<KeyMoveResult> {
  let ssh: NodeSSH;
  try {
    ssh = await openSsh(sshTarget({ ...server, password: null }), SSH_TUNING, {
      keyOnly: true,
      keyId: key.id,
      ...as,
    });
  } catch (error) {
    return { ok: false, code: connectFailure(error, "key", false) };
  }
  try {
    if (await keepOnly(ssh, server, keyMarker(key.id))) {
      // Signed in with the key: a server installed by hand is now verified.
      await db
        .update(servers)
        .set({ keyError: null })
        .where(
          and(eq(servers.id, server.id), eq(servers.keyError, KEY_NOT_VERIFIED))
        );
      return { ok: true };
    }
    console.error(`rotate key: old lines kept on server ${server.id}`);
    return { ok: false, code: "oldKeyNotRemoved" };
  } finally {
    ssh.dispose();
  }
}

async function rotateLocked(
  serverId: string,
  key: InstanceKey,
  previousKeyId: string,
  actorId: string,
  as: ConnectAs
): Promise<KeyMoveResult | null> {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (server?.auth !== "key") return null;
  if (server.sshKeyId === key.id) return cleanLocked(server, key, as);
  const fail = (code: KeyMoveCode): KeyMoveResult => ({ ok: false, code });
  // The key the server has; a row that lost it (never expected) most likely
  // still has the previous one.
  const oldKeyId = server.sshKeyId ?? previousKeyId;
  const oldMarker = keyMarker(oldKeyId);
  const marker = keyMarker(key.id);
  const target = sshTarget({ ...server, password: null });

  let ssh: NodeSSH;
  try {
    ssh = await openSsh(target, SSH_TUNING, {
      keyOnly: true,
      keyId: oldKeyId,
      ...as,
    });
  } catch (error) {
    return fail(connectFailure(error, "key", false));
  }

  let from: string;
  let oldLineKept = false;
  try {
    // The restriction the old line has; a row without one (never expected)
    // gets the address this session comes from, as a move would.
    const address =
      server.sshFrom ??
      fromAddress(
        (await exec(ssh, "printf '%s' \"$SSH_CLIENT\"")).stdout,
        ownSubnet()
      );
    if (address === null) {
      console.error(`rotate key: no usable $SSH_CLIENT on server ${serverId}`);
      return fail("keyInstallFailed");
    }
    from = address;
    let line: string;
    try {
      line = authorizedKeysLine(key.publicKey, from, marker);
    } catch (error) {
      console.error(`rotate key: ${(error as Error).message}`);
      return fail("keyInstallFailed");
    }

    const existing = await readAuthorizedKeys(ssh);
    const previous = previousLine(existing, marker);
    // The old line stays as the proven way in until the new one is proven;
    // lines of any other key of ours go now (and come back on an undo).
    const ours = await ownKeyMarkers(server);
    let dropped: DroppedLine[] = dropOtherInstanceKeys(
      existing,
      [marker, oldMarker],
      ours
    ).dropped;
    const undo = async () => {
      if (previous === null && (await committedTo(serverId, key.id))) {
        console.error(
          `server ${serverId} already uses this key; its line is kept`
        );
        return;
      }
      await rollback(ssh, marker, previous, dropped);
    };
    try {
      dropped = await installLine(
        ssh,
        existing,
        line,
        marker,
        [oldMarker],
        ours
      );
    } catch (error) {
      await undo();
      throw error;
    }

    const loginFailure = await proveKeyLogin(target, key.id, as);
    if (loginFailure) {
      await undo();
      return fail(loginFailure);
    }

    // The row first: until it points at the new key, connections use the old
    // one, so the old line stays until then.
    const switched = await db
      .update(servers)
      .set({
        sshKeyId: key.id,
        sshFrom: from,
        keyError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(servers.id, serverId),
          eq(servers.host, server.host),
          eq(servers.username, server.username),
          eq(servers.auth, "key"),
          server.sshKeyId === null
            ? isNull(servers.sshKeyId)
            : eq(servers.sshKeyId, server.sshKeyId)
        )
      )
      .returning({ id: servers.id });
    if (switched.length === 0) {
      await undo();
      return fail("keyInstallFailed");
    }

    // Committed. A leftover old line would still let the old key in, so
    // the server is not done (and the key not retired) until it is gone.
    if (!(await keepOnly(ssh, server, marker))) {
      console.error(`rotate key: old line kept on server ${serverId}`);
      oldLineKept = true;
    }
  } catch (error) {
    if (error instanceof StepFailed) return fail(error.code);
    console.error(
      `rotate key failed on server ${serverId}:`,
      (error as Error).message
    );
    return fail("keyInstallFailed");
  } finally {
    ssh.dispose();
  }

  try {
    await recordActivity({
      actorId: activityActor(actorId),
      action: "server.keyRotated",
      entityType: "server",
      entityId: serverId,
      data: { server: server.name, from },
    });
  } catch {
    console.error(`rotate key: activity not recorded for server ${serverId}`);
  }
  return oldLineKept ? fail("oldKeyNotRemoved") : { ok: true };
}

// --- The instance's own network --------------------------------------------

export type NetworkSource = {
  env: Record<string, string | undefined>;
  inContainer: () => boolean;
  // /proc/net/route: what `ip -4 route` reads (the image has no iproute2).
  routeTable: () => string | null;
};

const systemNetwork: NetworkSource = {
  env: process.env,
  inContainer: () =>
    existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
  routeTable: () => {
    try {
      return readFileSync("/proc/net/route", "utf8");
    } catch {
      return null;
    }
  },
};

const V4_MIN_PREFIX = MIN_FROM_PREFIX[4];
const V6_MIN_PREFIX = MIN_FROM_PREFIX[6];

function ipv4ToInt(address: string): number {
  return address
    .split(".")
    .reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

function v4Mask(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

function ipv6ToBigInt(address: string): bigint | null {
  if (address.includes(".")) return null; // embedded IPv4: not a subnet form
  const [head = "", tail, ...rest] = address.split("::");
  if (rest.length > 0) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const all = [...left, ...Array<string>(missing).fill("0"), ...right];
  return all.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}

function bigIntToIpv6(n: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  return groups.join(":");
}

/**
 * `cidr` with its host bits zeroed, or null when it is not a CIDR or is wider
 * than /8 (IPv4) or /32 (IPv6): from= that wide is no restriction worth the
 * name, so the plain address is used instead.
 */
export function normaliseSubnet(cidr: string): string | null {
  const [address = "", prefix, ...rest] = cidr.trim().split("/");
  if (rest.length > 0 || prefix === undefined || !/^\d{1,3}$/.test(prefix)) {
    return null;
  }
  const bits = Number(prefix);
  const family = isIP(address);
  if (family === 4) {
    if (bits < V4_MIN_PREFIX || bits > 32) return null;
    return `${intToIpv4((ipv4ToInt(address) & v4Mask(bits)) >>> 0)}/${bits}`;
  }
  if (family === 6 && !address.includes("%")) {
    if (bits < V6_MIN_PREFIX || bits > 128) return null;
    const n = ipv6ToBigInt(address);
    if (n === null) return null;
    const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
    return `${bigIntToIpv6(n & mask)}/${bits}`;
  }
  return null;
}

// /proc/net/route stores IPv4 addresses as host-order (little-endian) hex.
function routeAddress(hex: string): number {
  const n = Number.parseInt(hex, 16);
  return (
    (((n & 0xff) << 24) |
      (((n >>> 8) & 0xff) << 16) |
      (((n >>> 16) & 0xff) << 8) |
      ((n >>> 24) & 0xff)) >>>
    0
  );
}

function prefixLength(mask: number): number {
  let bits = 0;
  for (let m = mask; m & 0x80000000; m = (m << 1) >>> 0) bits++;
  return bits;
}

const PRIVATE_V4: [number, number][] = [
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
];

// Bridges that only exist in the host's own network namespace: seeing one
// means the container shares the host's network (network_mode: host), whose
// subnet is the LAN, not a compose network.
const HOST_BRIDGE = /^(docker\d|br-|podman|cni|virbr|veth)/;

const RTF_UP = 0x1;
const RTF_GATEWAY = 0x2;

/**
 * The subnet a route table says the container's compose bridge is, or null.
 * The strict rule, so from= never widens to a LAN: the connected route of the
 * default route's interface, private (RFC 1918), /12 to /30, with the default
 * gateway at its first address (how Docker and Podman number a bridge), and
 * no host bridge interface in the table.
 */
function bridgeSubnet(table: string): string | null {
  const routes = table
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 8)
    .map(
      ([
        iface = "",
        destination = "",
        gateway = "",
        flags = "",
        ,
        ,
        ,
        mask = "",
      ]) => ({
        iface,
        destination: routeAddress(destination),
        gateway: routeAddress(gateway),
        flags: Number.parseInt(flags, 16),
        mask: routeAddress(mask),
      })
    )
    .filter((r) => r.flags & RTF_UP);
  if (routes.some((r) => HOST_BRIDGE.test(r.iface))) return null;
  const defaultRoute = routes.find(
    (r) => r.destination === 0 && r.mask === 0 && r.flags & RTF_GATEWAY
  );
  if (!defaultRoute) return null;
  const connected = routes.find(
    (r) =>
      r.iface === defaultRoute.iface &&
      r.destination !== 0 &&
      !(r.flags & RTF_GATEWAY)
  );
  if (!connected) return null;
  const bits = prefixLength(connected.mask);
  if (bits < 12 || bits > 30) return null;
  const isPrivate = PRIVATE_V4.some(
    ([net, blockBits]) =>
      bits >= blockBits &&
      (connected.destination & v4Mask(blockBits)) >>> 0 === net
  );
  if (!isPrivate) return null;
  if (defaultRoute.gateway !== connected.destination + 1) return null;
  return normaliseSubnet(`${intToIpv4(connected.destination)}/${bits}`);
}

// Residual: the route table cannot tell every network mode apart. With
// network_mode: host, rootless Podman's own netns (pasta or slirp4netns),
// macvlan or ipvlan, the subnet read here can be the LAN's (say a /24), and
// from= would then admit every neighbour. The shipped compose file uses a
// bridge network; any other setup sets OPSDECK_NETWORK_SUBNET.

/**
 * The CIDR of the network the Panel's container sits in, which servers on the
 * same host see its connections come from (the compose bridge, whose
 * addresses change on recreate). OPSDECK_NETWORK_SUBNET wins (normalised; one
 * wider than /8 or /32 means none); otherwise the bridge subnet read from the
 * container's route table. Outside a container there is none: the host's LAN
 * subnet would widen from= to every neighbour. The install compose file does
 * not set the env var (install.sh cannot know the subnet before the first
 * start), so installs rely on the route table.
 */
export function ownSubnet(
  source: NetworkSource = systemNetwork
): string | null {
  const configured = source.env.OPSDECK_NETWORK_SUBNET?.trim();
  if (configured) return normaliseSubnet(configured);
  if (!source.inContainer()) return null;
  const table = source.routeTable();
  return table ? bridgeSubnet(table) : null;
}

// --- Route actions (org server:manage) ---------------------------------------

/** Answer a key action's failure code as an HTTP error (409; 502 unreachable). */
export async function refuse(code: string): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  throw new CodedHTTPException(
    code === "unreachable" ? 502 : 409,
    code,
    t(code)
  );
}

async function requireServer(serverId: string) {
  const [row] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!row) {
    const t = await getServerTranslator("actionErrors");
    throw new CodedHTTPException(404, "serverNotFound", t("serverNotFound"));
  }
}

/** Move a password server to the key with its stored password. */
export async function moveToKeyAction(serverId: string): Promise<{ ok: true }> {
  const session = await requireOrgPermission({ server: ["manage"] });
  await requireServer(serverId);
  const result = await moveServerToKey(serverId, session.user.id);
  if (!result.ok) return refuse(result.code);
  return { ok: true };
}

/** Rewrite the key line with a password typed once (never stored). */
export async function reinstallKeyAction(
  serverId: string,
  password: string
): Promise<{ ok: true }> {
  const session = await requireOrgPermission({ server: ["manage"] });
  await requireServer(serverId);
  const result = await moveServerToKey(serverId, session.user.id, {
    passwordOnce: password,
  });
  if (!result.ok) return refuse(result.code);
  return { ok: true };
}

/** Pin the host key the server offered, if it is still the one checked. */
export async function trustHostKeyAction(
  serverId: string,
  expectedFingerprint: string
): Promise<{ ok: true }> {
  const session = await requireOrgPermission({ server: ["manage"] });
  await requireServer(serverId);
  const result = await trustOfferedHostKey(
    serverId,
    session.user.id,
    expectedFingerprint
  );
  if (!result.ok) return refuse(result.code);
  // The mismatch that stopped a move is resolved; other key errors stay.
  await db
    .update(servers)
    .set({ keyError: null })
    .where(
      and(eq(servers.id, serverId), eq(servers.keyError, "hostKeyMismatch"))
    );
  return { ok: true };
}

// --- A key installed by hand (org server:manage) -----------------------------

async function requireKeyServer(serverId: string) {
  const [row] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!row) {
    const t = await getServerTranslator("actionErrors");
    throw new CodedHTTPException(404, "serverNotFound", t("serverNotFound"));
  }
  if (row.auth !== "key") return refuse("notKeyServer");
  return row;
}

async function requireFrom(from: string) {
  if (!isValidFrom(from)) {
    const t = await getServerTranslator("actionErrors");
    throw new CodedHTTPException(400, "invalidFrom", t("invalidFrom"));
  }
}

/**
 * The line of the key a key server's row names (the current key when it
 * names none), restricted to `from`, with the command that installs it: what
 * the server page shows so a key server installed by hand is never a dead end.
 */
export async function serverAuthorizedLineAction(
  serverId: string,
  from: string
): Promise<{ line: string; command: string }> {
  await requireOrgPermission({ server: ["manage"] });
  const server = await requireKeyServer(serverId);
  await requireFrom(from);
  const key = await keyToInstall(server);
  if (!key) return refuse("keyInstallFailed");
  const line = authorizedKeysLine(key.publicKey, from, keyMarker(key.id));
  return { line, command: installCommand(line) };
}

/**
 * The key a key server's line should carry: the one its row names, or the
 * current key while the row was never verified (a server added by hand during
 * a rotation must not land on the key being retired).
 */
async function keyToInstall(server: Server): Promise<InstanceKey | null> {
  if (server.sshKeyId && server.keyError !== KEY_NOT_VERIFIED) {
    return instanceKey(server.sshKeyId);
  }
  return ensureCurrentKey();
}

/**
 * Sign in to a key server with its key alone (never a password), then read
 * our line for that key from its authorized_keys. Success clears key_error,
 * points the row at that key, and saves the from= the line really carries
 * (never an address the browser sends), recording a change in the activity
 * log. A login without our line answers keyLineNotFound and saves nothing. A
 * failure changes nothing. Held under the server's key lock, so it never
 * races a move or a rotation of the same server.
 */
export async function checkKeyLoginAction(
  serverId: string
): Promise<{ ok: true }> {
  const session = await requireOrgPermission({ server: ["manage"] });
  const server = await requireKeyServer(serverId);
  const release = await serverKeyLock(serverId);
  if (!release) return refuse("keyJobRunning");
  let failure: KeyMoveCode | "keyLineNotFound" | null = null;
  let from: string | null = null;
  try {
    const key = await keyToInstall(server);
    if (!key) return refuse("keyLoginFailed");
    let ssh: NodeSSH | undefined;
    try {
      ssh = await openSsh(
        sshTarget({ ...server, password: null }),
        SSH_TUNING,
        // Verified only on this action's own success path below, once our
        // line was found and its from= read.
        {
          keyOnly: true,
          keyId: key.id,
          actor: session.user.id,
          markVerified: false,
        }
      );
      const result = await exec(ssh, "true");
      if (result.code !== 0) failure = "keyLoginFailed";
      else {
        const line = previousLine(
          await readAuthorizedKeys(ssh),
          keyMarker(key.id)
        );
        from = line === null ? null : fromOfLine(line);
        if (from === null) failure = "keyLineNotFound";
      }
    } catch (error) {
      failure =
        error instanceof StepFailed
          ? error.code
          : connectFailure(error, "key", false);
    } finally {
      ssh?.dispose();
    }
    if (failure === null && from !== null) {
      // Conditional on the login it proved: an edit meanwhile is another
      // machine or account.
      const updated = await db
        .update(servers)
        .set({
          keyError: null,
          sshKeyId: key.id,
          sshFrom: from,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(servers.id, serverId),
            eq(servers.auth, "key"),
            eq(servers.host, server.host),
            eq(servers.username, server.username)
          )
        )
        .returning({ id: servers.id });
      if (updated.length > 0 && from !== server.sshFrom) {
        try {
          await recordActivity({
            actorId: session.user.id,
            action: "server.keyFromChanged",
            entityType: "server",
            entityId: serverId,
            data: {
              server: server.name,
              before: server.sshFrom ?? "",
              after: from,
            },
          });
        } catch {
          console.error(`check key: activity not recorded for ${serverId}`);
        }
      }
    }
  } finally {
    await release().catch(() =>
      console.error(`server key lock release failed for ${serverId}`)
    );
  }
  if (failure !== null) return refuse(failure);
  return { ok: true };
}
