import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { ConnectConfig, ServerHostKeyAlgorithm } from "ssh2";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import {
  ensureCurrentKey,
  KEY_NOT_VERIFIED,
  loadPrivateKey,
  sshFingerprint,
} from "@/lib/ssh-keys";

// The one place an SSH connect config is built. Every client (commands, file
// transfers, the SFTP explorer, the terminal sidecar) connects with what
// connectConfig returns, so none can skip host key verification:
//   - pinned key: the offered key blob must equal it, byte for byte;
//   - no pin yet: trust on first use, pinned atomically (one winner) and
//     recorded in the activity log;
//   - mismatch: refused inside the key exchange, before any auth is tried, and
//     the offered fingerprint is stored for an admin to review.
// Server-only: it reads the decrypted private key.

export type SshTarget = {
  // Null for a server that is not saved yet (the new-server form's test).
  serverId: string | null;
  host: string;
  // Real servers listen on 22; only the tests' in-process sshd sets this.
  port?: number;
  username: string;
  password: string | null;
  auth: "password" | "key";
};

/** The target for a server row; the password must already be decrypted. */
export function sshTarget(server: {
  id: string;
  host: string;
  username: string;
  password: string | null;
  auth: "password" | "key";
}): SshTarget {
  return {
    serverId: server.id,
    host: server.host,
    username: server.username,
    password: server.password,
    auth: server.auth,
  };
}

export type ObservedHostKey = {
  type: string;
  // Base64 of the raw public key blob, as stored in servers.host_key.
  key: string;
  fingerprint: string;
};

export type ConnectOptions = {
  // Offer the instance key only, never a password (key login verification).
  keyOnly?: boolean;
  // The instance key to sign in with, instead of the one the server has
  // (verifying a key just installed).
  keyId?: string;
  // A password typed for this one connection; never stored.
  passwordOnce?: string;
  // Who a trust-on-first-use pin is recorded for: a user id, or "system".
  actor?: string;
  // The background job that connects (an ssh_key_jobs id), recorded with a
  // pin or a mismatch it runs into.
  job?: string;
  // False: a key login with this config does not mark the server verified
  // (connectSucceeded); Check key login decides that itself.
  markVerified?: boolean;
  // Called with the key an unsaved target offered (nothing is pinned for it).
  onHostKey?: (hostKey: ObservedHostKey) => void;
};

export class HostKeyMismatchError extends Error {
  readonly code = "hostKeyMismatch";

  constructor(
    readonly offeredFingerprint: string,
    readonly pinnedFingerprint: string | null
  ) {
    super(
      `Host key mismatch: the server offered ${offeredFingerprint}, the pinned key is ${pinnedFingerprint ?? "unknown"}`
    );
    this.name = "HostKeyMismatchError";
  }
}

type Verify = (permitted: boolean) => void;
type HostVerifier = (key: Buffer, verify: Verify) => void;

// ssh2 only reports "Host denied (verification failed)"; the verifier records
// why, keyed by itself because callers spread the config into a new object.
const mismatches = new WeakMap<HostVerifier, HostKeyMismatchError>();

// The saved server and instance key a config signs in with, keyed like
// `mismatches`, so connectSucceeded knows which key login it proved.
const keyLogins = new WeakMap<
  HostVerifier,
  { serverId: string; keyId: string }
>();

/**
 * To call once a connect made with `config` is signed in. A key login proves
 * the key works there, so a server installed by hand stops showing "not
 * verified" (only for the key its row names). One conditional UPDATE, not
 * awaited: it never delays or fails the connection.
 */
export function connectSucceeded(config: ConnectConfig): void {
  const verifier = config.hostVerifier as HostVerifier | undefined;
  const login = verifier && keyLogins.get(verifier);
  if (!login) return;
  keyLogins.delete(verifier);
  db.update(servers)
    .set({ keyError: null })
    .where(
      and(
        eq(servers.id, login.serverId),
        eq(servers.keyError, KEY_NOT_VERIFIED),
        eq(servers.sshKeyId, login.keyId)
      )
    )
    .then(
      () => {},
      (error: unknown) =>
        console.error(
          `clearing keyNotVerified failed for server ${login.serverId}:`,
          (error as Error).message
        )
    );
}

/**
 * The error to surface for a failed connect made with `config`: the
 * HostKeyMismatchError its verifier recorded, else `error` unchanged.
 */
export function connectError(config: ConnectConfig, error: unknown): unknown {
  const verifier = config.hostVerifier as HostVerifier | undefined;
  return (verifier && mismatches.get(verifier)) ?? error;
}

const OFFERED_CLEARED = {
  hostKeyOfferedType: null,
  hostKeyOffered: null,
  hostKeyOfferedFingerprint: null,
} as const;

/** Every pin column cleared: the next connection trusts on first use. */
export const HOST_KEY_CLEARED = {
  hostKeyType: null,
  hostKey: null,
  hostKeyFingerprint: null,
  hostKeyPinnedAt: null,
  ...OFFERED_CLEARED,
} as const;

// Host key algorithms that produce a key blob of each type. Once a server is
// pinned, only its pinned type is negotiated (as OpenSSH prefers the types in
// known_hosts), so a server that adds a key of another type is not mistaken
// for a changed one.
const ALGORITHMS_FOR_TYPE: Record<string, ServerHostKeyAlgorithm[]> = {
  "ssh-ed25519": ["ssh-ed25519"],
  "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
  "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
  "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
  "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
};

export async function connectConfig(
  target: SshTarget,
  opts: ConnectOptions = {}
): Promise<ConnectConfig> {
  const stored = target.serverId
    ? (
        await db
          .select({
            hostKeyType: servers.hostKeyType,
            sshKeyId: servers.sshKeyId,
          })
          .from(servers)
          .where(eq(servers.id, target.serverId))
          .limit(1)
      )[0]
    : undefined;

  const config: ConnectConfig = {
    host: target.host,
    port: target.port ?? 22,
    username: target.username,
    hostVerifier: hostVerifier(target, opts),
  };
  const algorithms = stored?.hostKeyType
    ? ALGORITHMS_FOR_TYPE[stored.hostKeyType]
    : undefined;
  if (algorithms) config.algorithms = { serverHostKey: algorithms };

  const useKey =
    opts.keyOnly || (target.auth === "key" && opts.passwordOnce === undefined);
  if (useKey) {
    const keyId =
      opts.keyId ?? stored?.sshKeyId ?? (await ensureCurrentKey()).id;
    config.privateKey = await loadPrivateKey(keyId);
    if (target.serverId && config.hostVerifier && opts.markVerified !== false) {
      keyLogins.set(config.hostVerifier as HostVerifier, {
        serverId: target.serverId,
        keyId,
      });
    }
  } else {
    const password = opts.passwordOnce ?? target.password;
    if (password !== null) config.password = password;
  }
  return config;
}

function hostVerifier(target: SshTarget, opts: ConnectOptions): HostVerifier {
  const verifier: HostVerifier = (key, verify) => {
    checkHostKey(target, key, opts).then(
      () => verify(true),
      (error: unknown) => {
        if (error instanceof HostKeyMismatchError) {
          mismatches.set(verifier, error);
        } else {
          console.error("SSH host key check failed:", error);
        }
        verify(false);
      }
    );
  };
  return verifier;
}

function describeHostKey(blob: Buffer): ObservedHostKey {
  // An SSH public key blob starts with its type as a length-prefixed string.
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type =
    length > 0 && length <= blob.length - 4
      ? blob.subarray(4, 4 + length).toString("latin1")
      : "unknown";
  return {
    type,
    key: blob.toString("base64"),
    fingerprint: sshFingerprint(blob),
  };
}

async function readPin(serverId: string) {
  const [row] = await db
    .select({
      name: servers.name,
      host: servers.host,
      hostKey: servers.hostKey,
      hostKeyFingerprint: servers.hostKeyFingerprint,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!row) throw new Error("server not found");
  return row;
}

// Resolves when the offered key is acceptable; throws HostKeyMismatchError on
// a mismatch and any other error when it cannot be checked (both refuse).
async function checkHostKey(
  target: SshTarget,
  blob: Buffer,
  opts: ConnectOptions
): Promise<void> {
  const observed = describeHostKey(blob);
  const { serverId } = target;
  if (serverId === null) {
    opts.onHostKey?.(observed);
    return;
  }

  let pin = await readPin(serverId);
  // The row's address changed since the target was loaded: its pin (or lack
  // of one) is not about the host we reached.
  if (pin.host !== target.host) throw new Error("server host changed");

  if (pin.hostKey === null) {
    // Only one concurrent first connection wins; the rest compare against it.
    const won = await db
      .update(servers)
      .set({
        hostKeyType: observed.type,
        hostKey: observed.key,
        hostKeyFingerprint: observed.fingerprint,
        hostKeyPinnedAt: new Date(),
        ...OFFERED_CLEARED,
      })
      .where(
        and(
          eq(servers.id, serverId),
          isNull(servers.hostKey),
          eq(servers.host, target.host)
        )
      )
      .returning({ id: servers.id });
    if (won.length > 0) {
      await recordActivity({
        actorId: actorId(opts),
        action: "server.hostKeyPinned",
        entityType: "server",
        entityId: serverId,
        data: {
          server: pin.name,
          fingerprint: observed.fingerprint,
          ...(opts.job ? { job: opts.job } : {}),
        },
      });
      return;
    }
    pin = await readPin(serverId);
    if (pin.host !== target.host || pin.hostKey === null) {
      throw new Error("host key pin changed during connect");
    }
  }

  if (Buffer.from(pin.hostKey, "base64").equals(blob)) return;

  // Keep exactly the key offered, so trusting it pins this key and no other.
  // Only a newly offered key is recorded in the activity log, not every
  // refused connection.
  const recorded = await db
    .update(servers)
    .set({
      hostKeyOfferedType: observed.type,
      hostKeyOffered: observed.key,
      hostKeyOfferedFingerprint: observed.fingerprint,
    })
    .where(
      and(
        eq(servers.id, serverId),
        // An edit to another address in between: this key is not its offer.
        eq(servers.host, target.host),
        or(
          isNull(servers.hostKeyOfferedFingerprint),
          ne(servers.hostKeyOfferedFingerprint, observed.fingerprint)
        )
      )
    )
    .returning({ id: servers.id });
  if (recorded.length > 0) {
    await recordActivity({
      actorId: actorId(opts),
      action: "server.hostKeyMismatch",
      entityType: "server",
      entityId: serverId,
      data: {
        server: pin.name,
        fingerprint: observed.fingerprint,
        pinned: pin.hostKeyFingerprint ?? "",
        ...(opts.job ? { job: opts.job } : {}),
      },
    });
  }
  throw new HostKeyMismatchError(observed.fingerprint, pin.hostKeyFingerprint);
}

function actorId(opts: ConnectOptions): string | null {
  return !opts.actor || opts.actor === "system" ? null : opts.actor;
}

/**
 * Trust the key a server offered after a mismatch: exactly that key becomes
 * the pin. `expectedFingerprint` is the offered fingerprint the admin checked;
 * if the server has offered another key since, nothing changes and the result
 * is `hostKeyChanged`. The caller checks `server:manage`.
 */
export async function trustOfferedHostKey(
  serverId: string,
  actorId: string,
  expectedFingerprint: string
): Promise<{ ok: true } | { ok: false; code: "hostKeyChanged" }> {
  const [row] = await db
    .select({
      name: servers.name,
      hostKeyOfferedType: servers.hostKeyOfferedType,
      hostKeyOffered: servers.hostKeyOffered,
      hostKeyOfferedFingerprint: servers.hostKeyOfferedFingerprint,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!row) throw new Error("server not found");
  const { hostKeyOffered: key, hostKeyOfferedType: type } = row;
  if (
    !key ||
    !type ||
    row.hostKeyOfferedFingerprint !== expectedFingerprint ||
    sshFingerprint(Buffer.from(key, "base64")) !== expectedFingerprint
  ) {
    return { ok: false, code: "hostKeyChanged" };
  }
  // Conditional on the fingerprint still being the one checked: a key offered
  // in between wins nothing.
  const trusted = await db
    .update(servers)
    .set({
      hostKeyType: type,
      hostKey: key,
      hostKeyFingerprint: expectedFingerprint,
      hostKeyPinnedAt: new Date(),
      ...OFFERED_CLEARED,
    })
    .where(
      and(
        eq(servers.id, serverId),
        eq(servers.hostKeyOfferedFingerprint, expectedFingerprint)
      )
    )
    .returning({ id: servers.id });
  if (trusted.length === 0) return { ok: false, code: "hostKeyChanged" };
  await recordActivity({
    actorId,
    action: "server.hostKeyTrusted",
    entityType: "server",
    entityId: serverId,
    data: { server: row.name, fingerprint: expectedFingerprint },
  });
  return { ok: true };
}
