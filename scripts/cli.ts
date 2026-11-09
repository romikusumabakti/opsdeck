// The opsdeck CLI. In the image: `opsdeck <command>` (a wrapper for
// `bun dist/cli.js <command>`). Local dev: bun scripts/cli.ts <command>.
import { runBackup } from "./cli/backup";
import { runMigrate } from "./cli/migrate";
import { runRestoreCommand } from "./cli/restore";

const USAGE = `Usage: bun dist/cli.js <command> [options]   (in the image: opsdeck <command>)

Commands:
  migrate [--adopt]   Apply pending database migrations
  backup run [--trigger schedule|manual|update|restore]
                      Back up the instance to its S3 destination (or local)
  restore <objectKey> Restore an instance backup (the host updater runs it)

Run a command with --help for its options.`;

const commands: Record<string, (args: string[]) => Promise<number>> = {
  migrate: runMigrate,
  backup: runBackup,
  restore: runRestoreCommand,
};

const [command, ...args] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "help") {
  console.log(USAGE);
  process.exit(command === undefined ? 1 : 0);
}

const run = commands[command];
if (!run) {
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

process.exit(await run(args));
