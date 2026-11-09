import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { eq } from "drizzle-orm";
import { utils } from "ssh2";
import { db } from "@/lib/db";
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
  const pair = utils.generateKeyPairSync("ed25519");
  const publicKey = pair.public.trim();
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) throw parsed;
  const blob = Array.isArray(parsed)
    ? parsed[0].getPublicSSH()
    : parsed.getPublicSSH();
  const digest = createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/, "");
  return {
    publicKey,
    privateKeyPem: pair.private,
    fingerprint: `SHA256:${digest}`,
  };
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

function isOurs(line: string, marker: string): boolean {
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
