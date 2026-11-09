// The opsdeck CLI. In the image: `opsdeck <command>` (a wrapper for
// `bun dist/cli.js <command>`). Local dev: bun scripts/cli.ts <command>.
import { runMigrate } from "./cli/migrate";

const USAGE = `Usage: bun dist/cli.js <command> [options]   (in the image: opsdeck <command>)

Commands:
  migrate [--adopt]   Apply pending database migrations

Run a command with --help for its options.`;

const commands: Record<string, (args: string[]) => Promise<number>> = {
  migrate: runMigrate,
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
