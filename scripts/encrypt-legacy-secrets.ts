// One-off, idempotent: encrypts legacy plaintext secret columns with the
// enc:v1 scheme. Dry run by default; pass --apply to write. Prints counts only,
// never values.
// Usage (production): docker exec opsdeck-app bun dist/encrypt-legacy-secrets.js [--apply]
// Local dev: bun --conditions react-server scripts/encrypt-legacy-secrets.ts [--apply]
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  countSecrets,
  describeDbError,
  planEncryption,
  SECRET_COLUMNS,
} from "@/lib/secrets-migration";

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log(
    "Usage: bun dist/encrypt-legacy-secrets.js [--apply]\n" +
      "Encrypts legacy plaintext secret columns. Dry run unless --apply is given."
  );
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--apply");
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown[0]}`);
  process.exit(1);
}
const apply = args.includes("--apply");

if (!process.env.SECRETS_KEY) {
  console.error("SECRETS_KEY is not set");
  process.exit(1);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

for (const { table, column } of SECRET_COLUMNS) {
  const t = sql.identifier(table);
  const c = sql.identifier(column);
  let rows: { id: string; value: string | null }[];
  try {
    rows = (await db.execute(
      sql`SELECT id, ${c} AS value FROM ${t}`
    )) as unknown as { id: string; value: string | null }[];
  } catch (err) {
    fail(`${table}.${column}: select failed (${describeDbError(err)})`);
  }

  const changes = planEncryption(rows);
  const { encrypted, plaintext } = countSecrets(rows);
  const label = `${table}.${column}: ${encrypted}/${plaintext}`;

  if (!apply) {
    console.log(`${label} (would change ${changes.length})`);
    continue;
  }

  // Each row is its own statement; the guard makes a concurrent writer win
  // and an interrupted run leave every row wholly plaintext or wholly
  // encrypted.
  let changed = 0;
  let skipped = 0;
  for (const { id, from, to } of changes) {
    try {
      const updated = await db.execute(
        sql`UPDATE ${t} SET ${c} = ${to} WHERE id = ${id}::uuid AND ${c} = ${from} RETURNING 1`
      );
      if (updated.length === 1) changed++;
      else skipped++;
    } catch (err) {
      // drizzle's error message embeds the params (the secret): print a code only.
      fail(
        `${table}.${column}: update failed for row ${id} (${describeDbError(err)})`
      );
    }
  }
  console.log(
    `${label} (changed ${changed}${skipped ? `, skipped (changed concurrently) ${skipped}` : ""})`
  );
}

// The postgres.js pool would keep the process alive.
process.exit(0);
