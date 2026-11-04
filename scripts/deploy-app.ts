// Creates an app component (and its app when missing) or rotates the
// component's CI notify secret.
// Usage (production): docker exec opsdeck-app bun dist/deploy-app.js <create|rotate> <componentKey> ...
// Local dev: bun --conditions react-server scripts/deploy-app.ts <create|rotate> <componentKey> ...
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/lib/db";
import { appComponents, apps, ciConnections } from "@/lib/db/schema";
import {
  appKeySchema,
  bundleImageSchema,
  componentKeySchema,
} from "@/lib/deploy/validation";
import { isUniqueViolation } from "@/lib/people/names";
import { encryptSecret } from "@/lib/secrets";
import { describeDbError } from "@/lib/secrets-migration";

const USAGE = `Usage:
  bun dist/deploy-app.js create <componentKey> <bundleImage> --app <appKey> --repo <owner/name> [--ci <connection name>]
  bun dist/deploy-app.js rotate <componentKey>`;

const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help")) {
  console.log(
    `${USAGE}\nCreates an app component (and its app when missing) or rotates its CI notify secret.`
  );
  process.exit(0);
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: rawArgs,
      allowPositionals: true,
      options: {
        app: { type: "string" },
        repo: { type: "string" },
        ci: { type: "string" },
      },
    });
  } catch {
    return usage();
  }
})();
const [command, componentKey, bundleImage] = positionals;

if ((command !== "create" && command !== "rotate") || !componentKey) usage();
if (command === "create" && (!bundleImage || !values.app || !values.repo)) {
  usage();
}

// The same rules the hook (component key) and the deploy script (bundle
// image) apply, so a component registered here can actually be notified and
// deployed.
function check(schema: z.ZodType<string>, value: string) {
  const result = schema.safeParse(value);
  if (!result.success) {
    console.error(result.error.issues[0]?.message ?? "Invalid value");
    process.exit(1);
  }
}
check(componentKeySchema, componentKey);
if (command === "create") {
  check(bundleImageSchema, bundleImage as string);
  check(appKeySchema, values.app as string);
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo as string)) {
    console.error("Repo must be <owner>/<name>");
    process.exit(1);
  }
}

// Drizzle errors embed the query params (the encrypted notify secret), so a
// failure prints only a safe error code, never the error itself.
function failDb(error: unknown): never {
  console.error(`Database error (${describeDbError(error)})`);
  process.exit(1);
}

/** The named CI connection, or the only one when `--ci` is omitted. */
async function resolveCiConnectionId(name: string | undefined) {
  let rows: { id: string; name: string }[];
  try {
    rows = await db
      .select({ id: ciConnections.id, name: ciConnections.name })
      .from(ciConnections);
  } catch (error) {
    return failDb(error);
  }
  const names = rows.map((r) => r.name).join(", ") || "(none)";
  if (name === undefined) {
    if (rows.length === 1 && rows[0]) return rows[0].id;
    console.error(`Pass --ci <connection name>. Connections: ${names}`);
    process.exit(2);
  }
  const match = rows.find((r) => r.name === name);
  if (!match) {
    console.error(`Unknown CI connection "${name}". Connections: ${names}`);
    process.exit(2);
  }
  return match.id;
}

const secret = randomBytes(32).toString("hex");
const notifySecret = encryptSecret(secret);

if (command === "create") {
  const appKey = values.app as string;
  const ciConnectionId = await resolveCiConnectionId(values.ci);
  try {
    await db
      .insert(apps)
      .values({ appKey, name: appKey })
      .onConflictDoNothing({ target: apps.appKey });
    const [app] = await db
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.appKey, appKey));
    if (!app) throw new Error(`App ${appKey} vanished after insert`);
    await db.insert(appComponents).values({
      componentKey,
      appId: app.id,
      ciConnectionId,
      repoFullName: values.repo as string,
      bundleImage: bundleImage as string,
      notifySecret,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) failDb(error);
    console.error(`Component ${componentKey} already exists — use rotate`);
    process.exit(1);
  }
} else {
  let rows: { componentKey: string }[] = [];
  try {
    rows = await db
      .update(appComponents)
      .set({ notifySecret })
      .where(eq(appComponents.componentKey, componentKey))
      .returning({ componentKey: appComponents.componentKey });
  } catch (error) {
    failDb(error);
  }
  if (rows.length === 0) {
    console.error(`Unknown component: ${componentKey}`);
    process.exit(1);
  }
}

console.log(secret);
console.error(
  `Shown once. Put it in the Woodpecker repo secret opsdeck_notify.`
);
process.exit(0);
