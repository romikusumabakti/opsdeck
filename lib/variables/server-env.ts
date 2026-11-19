import { createHmac } from "node:crypto";
import { db } from "@/lib/db";
import { listTargetsForEnvironment } from "@/lib/deploy/repository";
import { COMPOSE_OVERRIDE_FILE } from "@/lib/deploy/script";
import { loadServerCredentials } from "@/lib/environments";
import { derivedKey } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { HostKeyMismatchError } from "@/lib/ssh-connect";
import { parseDotenv } from "@/lib/variables/dotenv";

// Reads the live `.env` of every deploy dir an environment's compose targets
// use, for the "Import .env from server" review and its save. SERVER-ONLY:
// `text` holds secrets and must never reach a response, a log line or an
// error. Every failure maps to a fixed status; no error message is kept,
// since a RemoteCommandError carries the command's stdout.

/** The most bytes of `.env` read (and accepted) from a server. */
export const SERVER_ENV_MAX_BYTES = 256 * 1024;

const READ_TIMEOUT_MS = 10_000;
const FINGERPRINT_INFO = "env-file-fingerprint-v1";

export type ServerEnvStatus =
  | "ok"
  | "dirMissing"
  | "fileMissing"
  | "tooLarge"
  | "parseError"
  | "unreachable"
  | "hostKeyMismatch";

export type ServerEnvFile = {
  serverId: string;
  serverName: string;
  deployDir: string;
  status: ServerEnvStatus;
  /** The failing statement's line, for `parseError`. */
  line?: number;
  /** Whether `compose.override.yaml` sits next to the `.env` (`ok` only). */
  overridePresent?: boolean;
  /** The file's content (`ok` only). Server-only: never returned. */
  text?: string;
  /** envFingerprint(text) (`ok` only), to detect a changed file on save. */
  fingerprint?: string;
};

/**
 * HMAC-SHA256 of the file's text under a key derived from SECRETS_KEY. Lets
 * the save tell whether the file changed since the review without giving the
 * browser a plain hash it could brute-force short secrets against.
 */
export function envFingerprint(text: string): string {
  return createHmac("sha256", derivedKey(FINGERPRINT_INFO))
    .update(text, "utf8")
    .digest("base64url");
}

/**
 * The read command for one deploy dir. It prints one status line and, for
 * `OK`, the file base64-encoded (exact bytes: the SSH session decodes and
 * trims output per chunk), capped one byte over the limit so an oversized
 * read is detected even if the file grew after the size check. It exits 0
 * once it has started reading; only a non-regular or unreadable `.env`
 * exits non-zero, before any byte is read.
 */
function readCommand(deployDir: string): string {
  return [
    `cd -- ${shq(deployDir)} 2>/dev/null || { echo DIR_MISSING; exit 0; }`,
    "[ -e .env ] || { echo FILE_MISSING; exit 0; }",
    "{ [ -f .env ] && [ -r .env ]; } || exit 3",
    `[ "$(wc -c < .env | tr -d ' ')" -le ${SERVER_ENV_MAX_BYTES} ] || { echo TOO_LARGE; exit 0; }`,
    `if [ -f ${shq(COMPOSE_OVERRIDE_FILE)} ]; then echo "OK 1"; else echo "OK 0"; fi`,
    `head -c ${SERVER_ENV_MAX_BYTES + 1} .env | base64`,
    "exit 0",
  ].join("\n");
}

type DirRead = Pick<
  ServerEnvFile,
  "status" | "line" | "overridePresent" | "text" | "fingerprint"
>;

function interpret(stdout: string): DirRead {
  const newline = stdout.indexOf("\n");
  const head = (newline < 0 ? stdout : stdout.slice(0, newline)).trim();
  if (head === "DIR_MISSING") return { status: "dirMissing" };
  if (head === "FILE_MISSING") return { status: "fileMissing" };
  if (head === "TOO_LARGE") return { status: "tooLarge" };
  if (head !== "OK 0" && head !== "OK 1") return { status: "unreachable" };

  const body = newline < 0 ? "" : stdout.slice(newline + 1).replace(/\s/g, "");
  const bytes = Buffer.from(body, "base64");
  if (bytes.length > SERVER_ENV_MAX_BYTES) return { status: "tooLarge" };
  const text = bytes.toString("utf8");
  const parsed = parseDotenv(text);
  if ("error" in parsed) {
    return { status: "parseError", line: parsed.error.line };
  }
  return {
    status: "ok",
    overridePresent: head === "OK 1",
    text,
    fingerprint: envFingerprint(text),
  };
}

async function readDir(serverId: string, deployDir: string): Promise<DirRead> {
  try {
    const credentials = await loadServerCredentials(serverId);
    if (!credentials) return { status: "unreachable" };
    const stdout = await executeRemoteCommand(
      credentials,
      readCommand(deployDir),
      { timeoutMs: READ_TIMEOUT_MS, quiet: true }
    );
    return interpret(stdout);
  } catch (error) {
    // The message is dropped on purpose: it may quote the file.
    return error instanceof HostKeyMismatchError
      ? { status: "hostKeyMismatch" }
      : { status: "unreachable" };
  }
}

/**
 * Reads the `.env` of each (server, deploy dir) the environment's compose
 * targets use, in parallel; several targets in one dir are one read, jar
 * and static targets are skipped. One failing dir never fails the others.
 */
export async function readEnvironmentEnvFiles(
  environmentId: string
): Promise<ServerEnvFile[]> {
  const targets = await listTargetsForEnvironment(environmentId);
  const dirs = new Map<string, { serverId: string; deployDir: string }>();
  for (const target of targets) {
    if (target.kind !== "compose") continue;
    const key = JSON.stringify([target.serverId, target.deployDir]);
    if (!dirs.has(key)) {
      dirs.set(key, { serverId: target.serverId, deployDir: target.deployDir });
    }
  }
  if (dirs.size === 0) return [];

  const serverIds = [...new Set([...dirs.values()].map((d) => d.serverId))];
  const servers = await db.query.servers.findMany({
    where: { id: { in: serverIds } },
    columns: { id: true, name: true },
  });
  const names = new Map(servers.map((s) => [s.id, s.name]));

  return Promise.all(
    [...dirs.values()].map(async ({ serverId, deployDir }) => ({
      serverId,
      serverName: names.get(serverId) ?? "",
      deployDir,
      ...(await readDir(serverId, deployDir)),
    }))
  );
}
