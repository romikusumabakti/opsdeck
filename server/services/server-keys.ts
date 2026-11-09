import { existsSync, readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { NodeSSH } from "node-ssh";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
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
  ensureCurrentKey,
  fromAddress,
  keyMarker,
  mergeAuthorizedKeys,
  removeAuthorizedKey,
} from "@/lib/ssh-keys";
import { CodedHTTPException } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// Moving a server from its stored password to the instance key, on production
// servers, so every step either finishes or puts things back:
//   1. sign in with the password (host key verified or pinned);
//   2. a non-root login must have NOPASSWD sudo, or the move stops here;
//   3. write our line into the login user's ~/.ssh/authorized_keys, replacing
//      the file atomically and leaving every other line as it was;
//   4. prove a fresh login with the key alone;
//   5. only then forget the password. A failed proof restores the line we
//      replaced (or removes ours), and the password stays.
// The password, the private key and the file's content are never logged,
// stored in key_error or returned.

export type KeyMoveCode =
  | "noPassword"
  | "unreachable"
  | "passwordRejected"
  | "hostKeyMismatch"
  | "sudoNeedsPassword"
  | "keyInstallFailed"
  | "keyLoginFailed";

export type KeyMoveResult = { ok: true } | { ok: false; code: KeyMoveCode };

const SSH_TUNING = { readyTimeout: 10_000 };
const COMMAND_TIMEOUT_MS = 15_000;

// The login user's authorized_keys, as POSIX sh run through `sh -c` (the
// login shell may not be sh). Both refuse a symlinked ~/.ssh or file: writing
// through one would edit a file elsewhere on the host.
const KEYS_PATHS =
  'case "$HOME" in /*) ;; *) exit 20 ;; esac; d="$HOME/.ssh"; f="$d/authorized_keys"';

// Prints the file (nothing when missing); creates ~/.ssh 0700 when missing.
const READ_SCRIPT = `${KEYS_PATHS}
if [ -L "$d" ]; then exit 21; fi
if [ ! -e "$d" ]; then mkdir -m 700 "$d" || exit 22; fi
if [ ! -d "$d" ] || [ -L "$f" ]; then exit 21; fi
if [ ! -e "$f" ]; then exit 0; fi
if [ ! -f "$f" ]; then exit 21; fi
cat "$f"`;

// Replaces the file with stdin: a temp file in ~/.ssh (same filesystem, so
// the rename is atomic), mode 0600, the old owner kept where we may, then
// renamed over the file.
const WRITE_SCRIPT = `${KEYS_PATHS}
if [ -L "$d" ] || [ ! -d "$d" ] || [ -L "$f" ]; then exit 21; fi
if [ -e "$f" ] && [ ! -f "$f" ]; then exit 21; fi
t=$(mktemp "$d/.authorized_keys.opsdeck.XXXXXX") || exit 23
if ! { cat > "$t" && chmod 600 "$t"; }; then rm -f "$t"; exit 23; fi
if [ -e "$f" ]; then chown "$(stat -c %u:%g "$f")" "$t" 2>/dev/null; fi
mv -f "$t" "$f" || { rm -f "$t"; exit 23; }
if command -v restorecon >/dev/null 2>&1; then restorecon "$f" 2>/dev/null; fi
exit 0`;

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

/** Why a sign-in failed, as a code (the error itself may name the host). */
function connectFailure(error: unknown, auth: "password" | "key"): KeyMoveCode {
  if (error instanceof HostKeyMismatchError) return "hostKeyMismatch";
  const level = (error as { level?: unknown } | null)?.level;
  if (level === "client-authentication") {
    return auth === "password" ? "passwordRejected" : "keyLoginFailed";
  }
  return auth === "password" ? "unreachable" : "keyLoginFailed";
}

async function readAuthorizedKeys(ssh: NodeSSH): Promise<string> {
  const result = await exec(ssh, READ_SCRIPT);
  if (result.code !== 0) {
    console.error(`authorized_keys read refused (exit ${result.code})`);
    throw new StepFailed("keyInstallFailed", "read authorized_keys");
  }
  return result.stdout;
}

async function writeAuthorizedKeys(ssh: NodeSSH, content: string) {
  const result = await exec(ssh, WRITE_SCRIPT, content);
  if (result.code !== 0) {
    console.error(`authorized_keys write refused (exit ${result.code})`);
    throw new StepFailed("keyInstallFailed", "write authorized_keys");
  }
}

/** Our line as it was before the install, if there was one. */
function previousLine(existing: string, marker: string): string | null {
  for (const line of existing.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#") && trimmed.split(/\s+/).at(-1) === marker) {
      return line.replace(/\r$/, "");
    }
  }
  return null;
}

/**
 * Put back what was there before our write: the previous line with our marker,
 * or none. Re-reads the file so a concurrent edit to other lines survives.
 */
async function rollback(ssh: NodeSSH, marker: string, previous: string | null) {
  try {
    const current = await readAuthorizedKeys(ssh);
    await writeAuthorizedKeys(
      ssh,
      previous === null
        ? removeAuthorizedKey(current, marker)
        : mergeAuthorizedKeys(current, previous, marker)
    );
  } catch {
    console.error("authorized_keys rollback failed; the password is kept");
  }
}

async function proveKeyLogin(
  target: SshTarget,
  keyId: string,
  actor: string
): Promise<KeyMoveCode | null> {
  let ssh: NodeSSH | undefined;
  try {
    ssh = await openSsh(target, SSH_TUNING, { keyOnly: true, keyId, actor });
    const result = await exec(ssh, "true");
    return result.code === 0 ? null : "keyLoginFailed";
  } catch (error) {
    return connectFailure(error, "key");
  } finally {
    ssh?.dispose();
  }
}

async function recordFailure(serverId: string, code: KeyMoveCode) {
  await db
    .update(servers)
    .set({ keyError: code, updatedAt: new Date() })
    .where(eq(servers.id, serverId));
}

/**
 * Install the instance key on a server and switch it to key login. With
 * `passwordOnce` (reinstall), that password signs in instead of the stored one
 * and is never stored. The caller checks `server:manage`; jobs call this too.
 */
export async function moveServerToKey(
  serverId: string,
  actorId: string,
  opts: { passwordOnce?: string } = {}
): Promise<KeyMoveResult> {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) throw new Error("server not found");

  const password = opts.passwordOnce ?? decryptNullable(server.password);
  const fail = async (code: KeyMoveCode): Promise<KeyMoveResult> => {
    await recordFailure(serverId, code);
    return { ok: false, code };
  };
  if (!password) return fail("noPassword");

  const key = await ensureCurrentKey();
  const marker = keyMarker(key.id);
  // A key server being reinstalled still signs in with the typed password.
  const target = sshTarget({ ...server, password, auth: "password" });

  let ssh: NodeSSH;
  try {
    ssh = await openSsh(target, SSH_TUNING, {
      passwordOnce: password,
      actor: actorId,
    });
  } catch (error) {
    return fail(connectFailure(error, "password"));
  }

  try {
    if (server.username !== "root") {
      const sudo = await exec(ssh, "sudo -n true");
      if (sudo.code !== 0) return fail("sudoNeedsPassword");
    }

    const sshClient = (await exec(ssh, "printf '%s' \"$SSH_CLIENT\"")).stdout;
    const from = fromAddress(sshClient, ownSubnet());
    if (from === null) {
      console.error(`move to key: no usable $SSH_CLIENT on server ${serverId}`);
      return fail("keyInstallFailed");
    }
    let line: string;
    try {
      line = authorizedKeysLine(key.publicKey, from, marker);
    } catch (error) {
      console.error(`move to key: ${(error as Error).message}`);
      return fail("keyInstallFailed");
    }

    const existing = await readAuthorizedKeys(ssh);
    const previous = previousLine(existing, marker);
    try {
      await writeAuthorizedKeys(
        ssh,
        mergeAuthorizedKeys(existing, line, marker)
      );
    } catch (error) {
      // A write cut off by the timeout may still have landed.
      await rollback(ssh, marker, previous);
      throw error;
    }

    const loginFailure = await proveKeyLogin(
      sshTarget({ ...server, password: null }),
      key.id,
      actorId
    );
    if (loginFailure) {
      await rollback(ssh, marker, previous);
      return fail(loginFailure);
    }

    // Conditional on the address: a host edited meanwhile is another machine,
    // and the key proven here says nothing about it.
    const switched = await db
      .update(servers)
      .set({
        auth: "key",
        sshKeyId: key.id,
        sshFrom: from,
        password: null,
        keyError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(servers.id, serverId), eq(servers.host, server.host)))
      .returning({ id: servers.id });
    if (switched.length === 0) {
      await rollback(ssh, marker, previous);
      return fail("keyInstallFailed");
    }

    await recordActivity({
      actorId,
      action:
        opts.passwordOnce === undefined
          ? "server.keyInstalled"
          : "server.keyReinstalled",
      entityType: "server",
      entityId: serverId,
      data: { server: server.name, from },
    });
    return { ok: true };
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

// /proc/net/route stores IPv4 addresses as host-order (little-endian) hex.
function ipv4FromHex(hex: string): number[] {
  const n = Number.parseInt(hex, 16);
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function prefixLength(mask: number[]): number {
  return mask.reduce(
    (bits, octet) => bits + (octet.toString(2).match(/1/g)?.length ?? 0),
    0
  );
}

const RTF_UP = 0x1;
const RTF_GATEWAY = 0x2;

/**
 * The CIDR of the network the Panel's container sits in, which servers on the
 * same host see its connections come from (the compose bridge, whose
 * addresses change on recreate). OPSDECK_NETWORK_SUBNET wins; otherwise the
 * connected route of the container's default interface. Outside a container
 * there is none: the host's LAN subnet would widen from= to every neighbour.
 */
export function ownSubnet(
  source: NetworkSource = systemNetwork
): string | null {
  const configured = source.env.OPSDECK_NETWORK_SUBNET?.trim();
  if (configured) return configured;
  if (!source.inContainer()) return null;
  const table = source.routeTable();
  if (!table) return null;

  const routes = table
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 8)
    .map(([iface = "", destination = "", , flags = "", , , , mask = ""]) => ({
      iface,
      destination,
      flags: Number.parseInt(flags, 16),
      mask,
    }))
    .filter((r) => r.flags & RTF_UP);
  const defaultRoute = routes.find(
    (r) => r.destination === "00000000" && r.flags & RTF_GATEWAY
  );
  if (!defaultRoute) return null;
  const connected = routes.find(
    (r) =>
      r.iface === defaultRoute.iface &&
      r.destination !== "00000000" &&
      !(r.flags & RTF_GATEWAY)
  );
  if (!connected) return null;
  return `${ipv4FromHex(connected.destination).join(".")}/${prefixLength(
    ipv4FromHex(connected.mask)
  )}`;
}

// --- Route actions (org server:manage) ---------------------------------------

async function refuse(code: string): Promise<never> {
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
