import { encryptSecret, isEncrypted } from "@/lib/secrets";

// The columns that hold app-level encrypted secrets. Rows written before
// encryption was introduced still hold plaintext; scripts/encrypt-legacy-secrets.ts
// migrates them. Deliberately excluded: jira_connections.webhook_secret (a URL
// token compared in plaintext by design) and accounts.access_token (owned by
// better-auth).
export const SECRET_COLUMNS = [
  { table: "servers", column: "password" },
  { table: "environment_services", column: "db_password" },
  { table: "environment_services", column: "mock_time_api_key" },
  { table: "s3_connections", column: "secret_key" },
] as const satisfies readonly {
  table: "servers" | "environment_services" | "s3_connections";
  column: string;
}[];

export type PlannedChange = { id: string; from: string; to: string };

/** True for a genuine legacy plaintext value (not NULL, "" or encrypted). */
function isLegacyPlaintext(value: string | null): value is string {
  return value != null && value !== "" && !isEncrypted(value);
}

/** Counts of already-encrypted and still-plaintext values in a column. */
export function countSecrets(rows: { value: string | null }[]): {
  encrypted: number;
  plaintext: number;
} {
  let encrypted = 0;
  let plaintext = 0;
  for (const { value } of rows) {
    if (isLegacyPlaintext(value)) plaintext++;
    else if (value != null && value !== "") encrypted++;
  }
  return { encrypted, plaintext };
}

/**
 * Plan the encryption of one secret column. Only true plaintext changes: NULL,
 * "" and values `isEncrypted` recognises are left alone, so a plan applied and
 * re-planned is empty.
 */
export function planEncryption(
  rows: { id: string; value: string | null }[]
): PlannedChange[] {
  const changes: PlannedChange[] = [];
  for (const { id, value } of rows) {
    if (!isLegacyPlaintext(value)) continue;
    changes.push({ id, from: value, to: encryptSecret(value) });
  }
  return changes;
}

/**
 * Describe a database failure without leaking anything from it. drizzle wraps
 * failures in an error whose message embeds the query parameters (the secret
 * being written), so only a short code or the error class name is returned,
 * never the message, stack or the error itself.
 */
export function describeDbError(err: unknown): string {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)) {
    return code;
  }
  const name = err instanceof Error ? err.constructor.name : "";
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "UnknownError";
}
