// Fills who pushed existing builds (or their commit author email when the forge
// sends no login) and the auto runs behind them from their CI pipelines, then gives
// pre-deploy backup runs the actor of their deploy run. Prints counts only.
// Usage (production): docker exec opsdeck-app bun dist/backfill-build-actors.js [--dry-run]
// Local dev: bun --conditions react-server scripts/backfill-build-actors.ts [--dry-run]
import "reflect-metadata";
import { describeDbError } from "@/lib/secrets-migration";
import { backfillBuildActors } from "@/server/services/backfill-build-actors";

const USAGE = "Usage: bun dist/backfill-build-actors.js [--dry-run]";
const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log(
    `${USAGE}\nFills who pushed existing builds (or their commit author email) and their auto runs from CI, then pre-deploy backup runs from their deploy runs. --dry-run writes nothing.`
  );
  process.exit(0);
}
if (args.some((a) => a !== "--dry-run")) {
  console.error(USAGE);
  process.exit(1);
}
const dryRun = args.includes("--dry-run");

try {
  const c = await backfillBuildActors({ dryRun });
  console.log(
    `${dryRun ? "Dry run: would fill" : "Filled"} ${c.buildsFilled} of ${c.builds} builds ` +
      `(${c.buildsSkipped} skipped), ${c.runsFilled} auto runs and ` +
      `${c.backupRunsFilled} of ${c.backupRuns} pre-deploy backup runs`
  );
  process.exit(0);
} catch (error) {
  // Drizzle errors embed query params; print only a safe code.
  console.error(`Backfill failed (${describeDbError(error)})`);
  process.exit(1);
}
