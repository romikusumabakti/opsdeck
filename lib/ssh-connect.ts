import { and, eq, isNull } from "drizzle-orm";
import type { ConnectConfig, ServerHostKeyAlgorithm } from "ssh2";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import {
  ensureCurrentKey,
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
  // A password typed for this one connection; never stored.
  passwordOnce?: string;
  // Who a trust-on-first-use pin is recorded for: a user id, or "system".
  actor?: string;
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

/**
 * The error to surface for a failed connect made with `config`: the
 * HostKeyMismatchError its verifier recorded, else `error` unchanged.
 */
export function connectError(config: ConnectConfig, error: unknown): unknown {
  const verifier = config.hostVerifier as HostVerifier | undefined;
  return (verifier && mismatches.get(verifier)) ?? error;
}

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
    const keyId = stored?.sshKeyId ?? (await ensureCurrentKey()).id;
    config.privateKey = await loadPrivateKey(keyId);
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
        hostKeyOfferedFingerprint: null,
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
      const actor = opts.actor ?? "system";
      await recordActivity({
        actorId: actor === "system" ? null : actor,
        action: "server.hostKeyPinned",
        entityType: "server",
        entityId: serverId,
        data: { server: pin.name, fingerprint: observed.fingerprint },
      });
      return;
    }
    pin = await readPin(serverId);
    if (pin.host !== target.host || pin.hostKey === null) {
      throw new Error("host key pin changed during connect");
    }
  }

  if (Buffer.from(pin.hostKey, "base64").equals(blob)) return;

  await db
    .update(servers)
    .set({ hostKeyOfferedFingerprint: observed.fingerprint })
    .where(eq(servers.id, serverId));
  throw new HostKeyMismatchError(observed.fingerprint, pin.hostKeyFingerprint);
}

/** Every pin column cleared: the next connection trusts on first use. */
export const HOST_KEY_CLEARED = {
  hostKeyType: null,
  hostKey: null,
  hostKeyFingerprint: null,
  hostKeyPinnedAt: null,
  hostKeyOfferedFingerprint: null,
} as const;

/**
 * Trust the key a server offered after a mismatch: the pin and the offered
 * value are cleared, so the next connection pins whatever the server offers.
 * The caller checks `server:manage`.
 */
export async function trustOfferedHostKey(
  serverId: string,
  actorId: string
): Promise<void> {
  const [before] = await db
    .select({
      name: servers.name,
      hostKeyOfferedFingerprint: servers.hostKeyOfferedFingerprint,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!before) throw new Error("server not found");
  await db
    .update(servers)
    .set(HOST_KEY_CLEARED)
    .where(eq(servers.id, serverId));
  await recordActivity({
    actorId,
    action: "server.hostKeyTrusted",
    entityType: "server",
    entityId: serverId,
    data: {
      server: before.name,
      fingerprint: before.hostKeyOfferedFingerprint ?? "",
    },
  });
}
