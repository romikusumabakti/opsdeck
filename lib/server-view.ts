import type { SafeServer, Server } from "@/lib/db/schema";
import { keyMarker } from "@/lib/ssh-keys";

// The browser shapes of a server row. Server-only (keyMarker reads the
// instance name).

/**
 * For the servers pages (server:read): no password, no host key blobs (only
 * their fingerprints), and what the access UI needs: whether a password is
 * stored, whether the server offered another host key, and the marker of the
 * Panel's authorized_keys line on it.
 */
export type ServerView = Omit<
  Server,
  | "password"
  | "hostKeyType"
  | "hostKey"
  | "hostKeyOfferedType"
  | "hostKeyOffered"
  | "hostKeyOfferedFingerprint"
> & {
  hasPassword: boolean;
  hostKeyMismatch: boolean;
  offeredFingerprint: string | null;
  keyMarker: string | null;
};

export function serverView({
  password,
  hostKeyType: _hostKeyType,
  hostKey: _hostKey,
  hostKeyOfferedType: _hostKeyOfferedType,
  hostKeyOffered: _hostKeyOffered,
  hostKeyOfferedFingerprint,
  ...rest
}: Server): ServerView {
  return {
    ...rest,
    hasPassword: password !== null,
    hostKeyMismatch: hostKeyOfferedFingerprint !== null,
    offeredFingerprint: hostKeyOfferedFingerprint,
    keyMarker:
      rest.auth === "key" && rest.sshKeyId ? keyMarker(rest.sshKeyId) : null,
  };
}

/**
 * For everyone else who sees a server through another object (an
 * environment's services, a tunnel): where it is, not how the Panel signs in.
 * Everything serverView drops, plus the fingerprints, the key, from= and the
 * key error.
 */
export function toSafeServer({
  password: _password,
  hostKeyType: _hostKeyType,
  hostKey: _hostKey,
  hostKeyFingerprint: _hostKeyFingerprint,
  hostKeyPinnedAt: _hostKeyPinnedAt,
  hostKeyOfferedType: _hostKeyOfferedType,
  hostKeyOffered: _hostKeyOffered,
  hostKeyOfferedFingerprint: _hostKeyOfferedFingerprint,
  sshKeyId: _sshKeyId,
  sshFrom: _sshFrom,
  keyError: _keyError,
  ...safe
}: Server): SafeServer {
  return safe;
}
