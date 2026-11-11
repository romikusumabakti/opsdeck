// Creates an app component (and its app when missing), registers a generated
// artifact component, or rotates a component's CI notify secret.
// Usage (production): docker exec opsdeck-app bun dist/deploy-app.js <create|create-artifact|set-secret|rotate> <componentKey> ...
// Local dev: bun scripts/deploy-app.ts <create|create-artifact|set-secret|rotate> <componentKey> ...
// First: create-artifact loads lib/authz, whose auth module (better-auth's
// passkey plugin) pulls in tsyringe, which needs the polyfill before anything.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
  bun dist/deploy-app.js create-artifact <componentKey> --app <appKey> --repo <owner/name> --spec <path.json> [--ci <connection name>]
  bun dist/deploy-app.js set-secret <componentKey> <secretName>   (value on stdin)
  bun dist/deploy-app.js rotate <componentKey>`;

const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help")) {
  console.log(
    `${USAGE}\nCreates an app component (and its app when missing), registers a generated artifact component in Woodpecker (its notify secret goes straight there), or rotates a component's CI notify secret.`
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
        spec: { type: "string" },
      },
    });
  } catch {
    return usage();
  }
})();
const [command, componentKey, bundleImage] = positionals;

if (
  !(
    command === "create" ||
    command === "create-artifact" ||
    command === "set-secret" ||
    command === "rotate"
  ) ||
  !componentKey
) {
  usage();
}
if (command === "create" && (!bundleImage || !values.app || !values.repo)) {
  usage();
}
if (
  command === "create-artifact" &&
  (bundleImage || !values.app || !values.repo || !values.spec)
) {
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
if (command === "create" || command === "create-artifact") {
  if (command === "create") check(bundleImageSchema, bundleImage as string);
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

if (command === "set-secret") {
  // The second positional is the secret name for this command.
  const secretName = bundleImage;
  if (!secretName) usage();
  // The value comes on stdin so it never sits in argv, the shell history or
  // the output; one trailing newline (from echo or a file) is dropped.
  const value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  const { ArtifactRegistrationError, setComponentSecret } = await import(
    "@/lib/ci/register-artifact-component"
  );
  try {
    await setComponentSecret(componentKey, secretName as string, value);
    console.log(`Stored Woodpecker secret ${secretName} for ${componentKey}`);
    process.exit(0);
  } catch (error) {
    if (error instanceof ArtifactRegistrationError) {
      console.error(error.message);
      process.exit(1);
    }
    console.error(`Storing the secret failed (${describeDbError(error)})`);
    process.exit(1);
  }
}

if (command === "create-artifact") {
  let spec: unknown;
  try {
    spec = JSON.parse(readFileSync(values.spec as string, "utf8"));
  } catch {
    console.error(`Cannot read a JSON build spec from ${values.spec}`);
    process.exit(1);
  }
  const { ArtifactRegistrationError, registerArtifactComponent } = await import(
    "@/lib/ci/register-artifact-component"
  );
  try {
    // The notify secret goes straight to Woodpecker; it is never printed.
    const registered = await registerArtifactComponent({
      componentKey,
      appKey: values.app as string,
      repoFullName: values.repo as string,
      ciConnectionName: values.ci,
      spec: spec as Parameters<typeof registerArtifactComponent>[0]["spec"],
    });
    console.log(
      `Registered ${registered.componentKey}: Woodpecker repo ${registered.ciRepoId}, notify secret ${registered.notifySecretName}`
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof ArtifactRegistrationError) {
      console.error(error.message);
      process.exit(1);
    }
    // Database errors embed query params; print only a safe code.
    console.error(`Registration failed (${describeDbError(error)})`);
    process.exit(1);
  }
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
  console.log(secret);
  console.error(
    "Shown once. Put it in the Woodpecker repo secret opsdeck_notify."
  );
} else {
  let rows: { notifySecretName: string }[] = [];
  try {
    rows = await db
      .update(appComponents)
      .set({ notifySecret })
      .where(eq(appComponents.componentKey, componentKey))
      .returning({ notifySecretName: appComponents.notifySecretName });
  } catch (error) {
    failDb(error);
  }
  const [row] = rows;
  if (!row) {
    console.error(`Unknown component: ${componentKey}`);
    process.exit(1);
  }
  console.log(secret);
  console.error(
    `Shown once. Put it in the Woodpecker repo secret ${row.notifySecretName}.`
  );
}
process.exit(0);
