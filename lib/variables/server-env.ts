import { createHmac } from "node:crypto";
import { db } from "@/lib/db";
import { listTargetsForEnvironment } from "@/lib/deploy/repository";
import { COMPOSE_OVERRIDE_FILE } from "@/lib/deploy/script";
import { loadServerCredentials } from "@/lib/environments";
import { derivedKey } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import { runRemoteScript } from "@/lib/ssh";
import { HostKeyMismatchError } from "@/lib/ssh-connect";
import { parseDotenv } from "@/lib/variables/dotenv";

// Reads the live `.env` of every deploy dir an environment's compose targets
// use, for the "Import .env from server" review and its save. SERVER-ONLY:
// `text` holds secrets and must never reach a response, a log line or an
// error. Every failure maps to a fixed status; no output or error message
// is logged or kept.

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
 * HMAC-SHA256 of the file's raw bytes (a string is taken as its UTF-8
 * bytes) under a key derived from SECRETS_KEY. Lets the save tell whether
 * the file changed since the review without giving the browser a plain hash
 * it could brute-force short secrets against.
 */
export function envFingerprint(data: Uint8Array | string): string {
  return createHmac("sha256", derivedKey(FINGERPRINT_INFO))
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("base64url");
}

/**
 * The POSIX sh script reading one deploy dir (exported as a test seam). It
 * prints one status line; for `OK`, the file base64-encoded (exact bytes:
 * the SSH session decodes output per chunk and trims it), capped one byte
 * over the limit so a file that grew after the size check is still caught,
 * then `END` only if both `head` and `base64` succeeded. Every failure to
 * read (no `base64`/`head`, unreadable or non-regular `.env`, a failed
 * pipeline) exits non-zero without `END`.
 */
export function serverEnvReadScript(deployDir: string): string {
  return [
    `cd -- ${shq(deployDir)} 2>/dev/null || { echo DIR_MISSING; exit 0; }`,
    "[ -e .env ] || { echo FILE_MISSING; exit 0; }",
    "{ [ -f .env ] && [ -r .env ]; } || exit 3",
    'for tool in head base64 wc tr; do command -v "$tool" >/dev/null 2>&1 || exit 4; done',
    `size=$(wc -c < .env | tr -d ' ') || exit 4`,
    // A failing wc leaves size empty; without this it would read as TOO_LARGE.
    '[ -n "$size" ] || exit 4',
    `[ "$size" -le ${SERVER_ENV_MAX_BYTES} ] || { echo TOO_LARGE; exit 0; }`,
    `if [ -f ${shq(COMPOSE_OVERRIDE_FILE)} ]; then echo "OK 1"; else echo "OK 0"; fi`,
    // POSIX sh has no pipefail: head's status comes back on fd 3 (the
    // substitution), base64 writes to the real stdout via fd 4, and the
    // substitution's own status is base64's.
    "exec 4>&1",
    `head_status=$( { { head -c ${SERVER_ENV_MAX_BYTES + 1} .env; echo "$?" >&3; } | base64 >&4; } 3>&1 ) || exit 5`,
    `[ "$head_status" = 0 ] || exit 5`,
    "echo END",
  ].join("\n");
}

type DirRead = Pick<
  ServerEnvFile,
  "status" | "line" | "overridePresent" | "text" | "fingerprint"
>;

function interpret(code: number | null, stdout: string): DirRead {
  const lines = stdout.split("\n").map((l) => l.trim());
  const head = lines[0] ?? "";
  if (code !== 0) return { status: "unreachable" };
  if (head === "DIR_MISSING") return { status: "dirMissing" };
  if (head === "FILE_MISSING") return { status: "fileMissing" };
  if (head === "TOO_LARGE") return { status: "tooLarge" };
  // `END` proves the whole file was read and encoded.
  if ((head !== "OK 0" && head !== "OK 1") || lines.at(-1) !== "END") {
    return { status: "unreachable" };
  }

  const body = lines.slice(1, -1).join("");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) {
    return { status: "unreachable" };
  }
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
    fingerprint: envFingerprint(bytes),
  };
}

async function readDir(serverId: string, deployDir: string): Promise<DirRead> {
  try {
    const credentials = await loadServerCredentials(serverId);
    if (!credentials) return { status: "unreachable" };
    // runRemoteScript logs nothing and never throws the output: stdout and
    // stderr may quote the file. `sh -c` pins POSIX sh whatever the login
    // shell is.
    const { code, stdout } = await runRemoteScript(
      credentials,
      `sh -c ${shq(serverEnvReadScript(deployDir))}`,
      { timeoutMs: READ_TIMEOUT_MS }
    );
    return interpret(code, stdout);
  } catch (error) {
    // Connect failure or timeout. The message is dropped on purpose.
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
