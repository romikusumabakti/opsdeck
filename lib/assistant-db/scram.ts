// SCRAM-SHA-256 verifier for a Postgres role (RFC 5802 / RFC 7677). Postgres
// accepts it in place of a plaintext password in CREATE/ALTER ROLE ...
// PASSWORD, so the Panel can give the Assistant's read-only role a password
// without ever sending the plaintext to the server.

const encoder = new TextEncoder();

const SALT_BYTES = 16;
const DEFAULT_ITERATIONS = 4096;

function base64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  ).toString("base64");
}

async function hmac(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(message));
}

/**
 * Returns `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (base64).
 * Only accepts `[A-Za-z0-9]` passwords (what generateAssistantDbPassword
 * produces), for which SASLprep is the identity; anything else throws.
 */
export async function scramSha256Verifier(
  password: string,
  opts: { salt?: Uint8Array; iterations?: number } = {}
): Promise<string> {
  if (!/^[A-Za-z0-9]+$/.test(password)) {
    throw new Error("SCRAM password must match [A-Za-z0-9]+");
  }
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const saltedPassword = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    base,
    256
  );
  const clientKey = await hmac(saltedPassword, "Client Key");
  const storedKey = await crypto.subtle.digest("SHA-256", clientKey);
  const serverKey = await hmac(saltedPassword, "Server Key");

  return `SCRAM-SHA-256$${iterations}:${base64(salt)}$${base64(storedKey)}:${base64(serverKey)}`;
}
