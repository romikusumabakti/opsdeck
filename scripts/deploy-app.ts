// Creates a deploy app or rotates its CI notify secret.
// Usage: bun --conditions react-server scripts/deploy-app.ts <create|rotate> <appKey> [bundleImage]
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployApps } from "@/lib/db/schema";
import { encryptSecret } from "@/lib/secrets";

const [command, appKey, bundleImage] = process.argv.slice(2);

function usage(): never {
  console.error(
    "Usage: bun --conditions react-server scripts/deploy-app.ts <create|rotate> <appKey> [bundleImage]"
  );
  process.exit(1);
}

if ((command !== "create" && command !== "rotate") || !appKey) usage();
if (command === "create" && !bundleImage) usage();

const secret = randomBytes(32).toString("hex");
const notifySecret = encryptSecret(secret);

if (command === "create") {
  await db
    .insert(deployApps)
    .values({ appKey, bundleImage: bundleImage as string, notifySecret });
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
