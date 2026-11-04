// Creates a deploy app or rotates its CI notify secret.
// Usage (production): docker exec opsdeck-app bun dist/deploy-app.js <create|rotate> <appKey> [bundleImage]
// Local dev: bun --conditions react-server scripts/deploy-app.ts <create|rotate> <appKey> [bundleImage]
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/lib/db";
import { deployApps } from "@/lib/db/schema";
import { appKeySchema, bundleImageSchema } from "@/lib/deploy/validation";
import { isUniqueViolation } from "@/lib/people/names";
import { encryptSecret } from "@/lib/secrets";

const [command, appKey, bundleImage] = process.argv.slice(2);

const USAGE =
  "Usage: bun dist/deploy-app.js <create|rotate> <appKey> [bundleImage]";

if (process.argv.slice(2).includes("--help")) {
  console.log(
    `${USAGE}\nCreates a deploy app or rotates its CI notify secret.`
  );
  process.exit(0);
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

if ((command !== "create" && command !== "rotate") || !appKey) usage();
if (command === "create" && !bundleImage) usage();

// The same rules the hook (app key) and the deploy script (bundle image)
// apply, so an app registered here can actually be notified and deployed.
function check(schema: z.ZodType<string>, value: string) {
  const result = schema.safeParse(value);
  if (!result.success) {
    console.error(result.error.issues[0]?.message ?? "Invalid value");
    process.exit(1);
  }
}
check(appKeySchema, appKey);
if (command === "create") check(bundleImageSchema, bundleImage as string);

const secret = randomBytes(32).toString("hex");
const notifySecret = encryptSecret(secret);

if (command === "create") {
  try {
    await db
      .insert(deployApps)
      .values({ appKey, bundleImage: bundleImage as string, notifySecret });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    console.error(`App ${appKey} already exists — use rotate`);
    process.exit(1);
  }
} else {
  const rows = await db
    .update(deployApps)
    .set({ notifySecret })
    .where(eq(deployApps.appKey, appKey))
    .returning({ appKey: deployApps.appKey });
  if (rows.length === 0) {
    console.error(`Unknown deploy app: ${appKey}`);
    process.exit(1);
  }
}

console.log(secret);
console.error(
  `Shown once. Put it in the Woodpecker org secret opsdeck_notify_${appKey}.`
);
process.exit(0);
