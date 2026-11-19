// `menara seed demo`: fictional sample data for beta instances — projects
// with environments, placeholder servers, services, a month of deploy history,
// staff, issues and a knowledge base — plus one sign-in account per role.
// Everything is keyed by a fixed key and kept when present, and rows that
// hang off a parent (comments, deployments, revisions) are added only with a
// parent created in the same run, so a second run changes nothing.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { instanceSettings } from "@/lib/db/schema";
import {
  seedEnvironments,
  seedProjects,
  seedServers,
  seedServices,
} from "./seed-steps/catalog";
import type { SeedContext } from "./seed-steps/context";
import { seedDeploys } from "./seed-steps/deploys";
import { seedIssues } from "./seed-steps/issues";
import { seedKnowledge } from "./seed-steps/knowledge";
import { seedAccounts, seedStaff } from "./seed-steps/people";

export { DEMO_ACCOUNTS } from "./seed-steps/people";

export const SEED_USAGE = `Usage: menara seed demo [--print-passwords] [--force]
  (in the image: bun dist/cli.js seed demo [--print-passwords] [--force])

Creates (or keeps, when present) fictional demo data:
- projects DEMO, DEMOPORTAL, NPMB, NPCP and BSAC, each with Dev, QA and Demo
  environments, on three placeholder servers (sandbox-N.invalid, never
  reachable), filed under fictional groups;
- the Demo Membership, Demo Portal and Demo Accounting services
  (repositories under demo-org/, a placeholder CI connection, no apps) as
  the projects' services, with a deploy target per environment and service, and 30 days of finished builds and deployments;
- ten staff members @example.invalid who cannot sign in, project
  memberships, issues with comments, labels and milestones, notifications,
  activity entries, and a small knowledge base;
- sign-in accounts for most roles (demo-admin, demo-infra, demo-observer,
  demo-engineer, demo-qa, demo-ba, demo-staff @example.invalid) with
  email+password sign-in.
Existing rows and accounts are never changed or reset. A project with a demo
key, or a collection with a demo name, that is not demo data is skipped with
nothing added under it; so is an account whose name someone else holds.
--print-passwords  Print the generated password of each account created now.
--force            Seed even when NODE_ENV=production and the update channel
                   is stable (refused otherwise).`;

export const DEMO_EMAIL_DOMAIN = "example.invalid";

export interface SeedOptions {
  printPasswords: boolean;
  force: boolean;
  nodeEnv: string | undefined;
  hashPassword: (password: string) => Promise<string>;
  encryptSecret: (plaintext: string) => string;
  out: (line: string) => void;
  // The moment the demo history ends at (tests pin it); defaults to now.
  now?: Date;
}

export class SeedRefusedError extends Error {}

const newPassword = () => randomBytes(18).toString("base64url");

/** Rows inserted per area by one run; all zero on a re-run. */
export type SeedCounts = Record<string, number>;

export async function seedDemo(
  db: PostgresJsDatabase,
  opts: SeedOptions
): Promise<SeedCounts> {
  const [settings] = await db
    .select({ channel: instanceSettings.updateChannel })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  const channel = settings?.channel ?? "stable";
  if (opts.nodeEnv === "production" && channel === "stable" && !opts.force) {
    throw new SeedRefusedError(
      "Refusing to seed demo data into a production instance on the stable channel (use --force to override)."
    );
  }

  // Printed once the transaction commits: a password for an account that a
  // rollback never created would be worthless, and misleading.
  const lines: string[] = [];
  const inserted: SeedCounts = {};
  await db.transaction(async (tx) => {
    const ctx: SeedContext = {
      tx,
      now: opts.now ?? new Date(),
      encryptSecret: opts.encryptSecret,
      newPassword,
      emailDomain: DEMO_EMAIL_DOMAIN,
      servers: new Map(),
      projects: new Map(),
      environments: new Map(),
      people: new Map(),
      inserted,
      lines,
    };
    await seedServers(ctx);
    await seedProjects(ctx);
    await seedServices(ctx);
    await seedEnvironments(ctx);
    await seedAccounts(ctx, opts);
    await seedStaff(ctx);
    await seedDeploys(ctx);
    await seedIssues(ctx);
    await seedKnowledge(ctx);
  });
  for (const line of lines) opts.out(line);
  const summary = Object.entries(inserted)
    .filter(([, n]) => n > 0)
    .map(([area, n]) => `${area} ${n}`)
    .join(", ");
  opts.out(`demo data added: ${summary || "nothing (already present)"}`);
  return inserted;
}

export async function runSeed(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(SEED_USAGE);
    return 0;
  }
  const [sub, ...flags] = args;
  const known = ["--print-passwords", "--force"];
  if (sub !== "demo" || flags.some((f) => !known.includes(f))) {
    console.error(SEED_USAGE);
    return 1;
  }
  // Loaded here so `--help` needs neither a database nor SECRETS_KEY.
  const [{ db, pgClient }, { auth }, { encryptSecret }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/auth"),
    import("@/lib/secrets"),
  ]);
  try {
    const context = await auth.$context;
    await seedDemo(db as unknown as PostgresJsDatabase, {
      printPasswords: flags.includes("--print-passwords"),
      force: flags.includes("--force"),
      nodeEnv: process.env.NODE_ENV,
      hashPassword: context.password.hash,
      encryptSecret,
      out: console.log,
    });
    return 0;
  } catch (error) {
    if (error instanceof SeedRefusedError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  } finally {
    await pgClient().end();
  }
}
