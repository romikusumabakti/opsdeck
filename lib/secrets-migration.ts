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
    if (value == null || value === "" || isEncrypted(value)) continue;
    changes.push({ id, from: value, to: encryptSecret(value) });
  }
  return changes;
}
