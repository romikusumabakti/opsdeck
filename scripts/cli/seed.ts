// `opsdeck seed demo`: sample projects, placeholder servers, a few issues and
// one sign-in account per role, for beta instances. Everything is keyed by a
// fixed key and kept when present, so a second run changes nothing.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { v7 as uuidv7 } from "uuid";
import {
  accounts,
  environments,
  type IssuePriority,
  type IssueStatus,
  type IssueType,
  instanceSettings,
  issues,
  projectMembers,
  projects,
  servers,
  users,
} from "@/lib/db/schema";
import type { OrgRole, ProjectRole } from "@/lib/permissions";

export const SEED_USAGE = `Usage: opsdeck seed demo [--print-passwords] [--force]
  (in the image: bun dist/cli.js seed demo [--print-passwords] [--force])

Creates (or keeps, when present) the demo projects DEMO and DEMOPORTAL with
Dev and QA environments, two placeholder servers (sandbox-N.invalid, never
reachable), a few issues, and one account per role (demo-admin, demo-infra,
demo-observer, demo-engineer, demo-qa, demo-viewer @example.invalid) with
email+password sign-in. Existing rows and accounts are never changed or reset.
--print-passwords  Print the generated password of each account created now.
--force            Seed even when NODE_ENV=production and the update channel
                   is stable (refused otherwise).`;

export const DEMO_EMAIL_DOMAIN = "example.invalid";

interface DemoAccount {
  name: string;
  orgRole: OrgRole;
  projectRole: ProjectRole | null;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { name: "demo-admin", orgRole: "admin", projectRole: null },
  { name: "demo-infra", orgRole: "infra", projectRole: null },
  { name: "demo-observer", orgRole: "observer", projectRole: null },
  { name: "demo-engineer", orgRole: "member", projectRole: "engineer" },
  { name: "demo-qa", orgRole: "member", projectRole: "qa" },
  { name: "demo-viewer", orgRole: "member", projectRole: "viewer" },
];

const DEMO_PROJECTS = [
  { key: "DEMO", name: "Demo Membership" },
  { key: "DEMOPORTAL", name: "Demo Portal" },
] as const;

const DEMO_ENVIRONMENTS = [
  { name: "Dev", slug: "dev", kind: "dev" },
  { name: "QA", slug: "qa", kind: "qa" },
] as const;

const DEMO_SERVERS = ["sandbox-1.invalid", "sandbox-2.invalid"] as const;

interface DemoIssue {
  number: number;
  title: string;
  status: IssueStatus;
  type: IssueType;
  priority: IssuePriority;
}

const DEMO_ISSUES: readonly DemoIssue[] = [
  {
    number: 1,
    title: "Member import rejects empty rows",
    status: "open",
    type: "bug",
    priority: "high",
  },
  {
    number: 2,
    title: "Add a contribution summary report",
    status: "in_progress",
    type: "story",
    priority: "medium",
  },
  {
    number: 3,
    title: "Document the QA release checklist",
    status: "resolved",
    type: "task",
    priority: "low",
  },
  {
    number: 4,
    title: "Retire the old export endpoint",
    status: "closed",
    type: "task",
    priority: "low",
  },
];

export interface SeedOptions {
  printPasswords: boolean;
  force: boolean;
  nodeEnv: string | undefined;
  hashPassword: (password: string) => Promise<string>;
  encryptSecret: (plaintext: string) => string;
  out: (line: string) => void;
}

export class SeedRefusedError extends Error {}

const newPassword = () => randomBytes(18).toString("base64url");

export async function seedDemo(
  db: PostgresJsDatabase,
  opts: SeedOptions
): Promise<void> {
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

  await db.transaction(async (tx) => {
    const projectIds: string[] = [];
    for (const project of DEMO_PROJECTS) {
      await tx.insert(projects).values(project).onConflictDoNothing();
      const [row] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, project.key));
      if (!row) throw new Error(`Project ${project.key} was not created`);
      projectIds.push(row.id);
    }

    for (const projectId of projectIds) {
      await tx
        .insert(environments)
        .values(DEMO_ENVIRONMENTS.map((e) => ({ ...e, projectId })))
        .onConflictDoNothing();
      await tx
        .insert(issues)
        .values(DEMO_ISSUES.map((i) => ({ ...i, projectId })))
        .onConflictDoNothing();
    }

    for (const host of DEMO_SERVERS) {
      const [existing] = await tx
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.host, host));
      if (existing) continue;
      await tx.insert(servers).values({
        name: host.replace(/\.invalid$/, ""),
        host,
        username: "demo",
        // A dummy: nothing can connect, so the value only has to be a valid
        // envelope under this instance's SECRETS_KEY.
        password: opts.encryptSecret(newPassword()),
        placement: "open",
      });
    }

    for (const account of DEMO_ACCOUNTS) {
      const email = `${account.name}@${DEMO_EMAIL_DOMAIN}`;
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      let userId = existing?.id;
      if (!userId) {
        userId = uuidv7();
        const password = newPassword();
        // Written directly, not through auth.api: the user.create hook rejects
        // any email outside ALLOWED_EMAIL_DOMAIN, and public sign-up is off.
        // The hash comes from better-auth, so sign-in verifies it unchanged.
        await tx.insert(users).values({
          id: userId,
          name: account.name,
          email,
          emailVerified: true,
          role: account.orgRole,
        });
        await tx.insert(accounts).values({
          id: uuidv7(),
          userId,
          accountId: userId,
          providerId: "credential",
          password: await opts.hashPassword(password),
        });
        opts.out(
          opts.printPasswords
            ? `created ${email} (${account.orgRole}) password: ${password}`
            : `created ${email} (${account.orgRole})`
        );
      } else {
        opts.out(`exists  ${email}`);
      }
      if (account.projectRole) {
        await tx
          .insert(projectMembers)
          .values(
            projectIds.map((projectId) => ({
              projectId,
              userId,
              role: account.projectRole as ProjectRole,
            }))
          )
          .onConflictDoNothing();
      }
    }
  });
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
