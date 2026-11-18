// The sign-in demo accounts and the fictional staff (no credential account,
// so they cannot sign in), with their project memberships.
import { and, eq, sql } from "drizzle-orm";
import { accounts, activityLog, projectMembers, users } from "@/lib/db/schema";
import type { OrgRole } from "@/lib/permissions";
import type { PersonRef } from "../seed-data/issues";
import {
  DEMO_STAFF,
  STAFF_TIME_ZONE,
  STAFF_WORKING_HOURS,
} from "../seed-data/people";
import { addDays, addMinutes } from "../seed-data/random";
import { count, type SeedContext } from "./context";

export interface DemoAccount {
  name:
    | "demo-admin"
    | "demo-infra"
    | "demo-observer"
    | "demo-engineer"
    | "demo-qa"
    | "demo-ba"
    | "demo-staff";
  orgRole: OrgRole;
  // A member of both original demo projects: what makes them visible to an
  // engineer, QA or BA.
  member: boolean;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { name: "demo-admin", orgRole: "admin", member: false },
  { name: "demo-infra", orgRole: "infra", member: false },
  { name: "demo-observer", orgRole: "observer", member: false },
  { name: "demo-engineer", orgRole: "engineer", member: true },
  { name: "demo-qa", orgRole: "qa", member: true },
  { name: "demo-ba", orgRole: "ba", member: true },
  // Staff sees no project, so no membership.
  { name: "demo-staff", orgRole: "staff", member: false },
];

// The projects the sign-in accounts belong to (as in the first seed).
const ACCOUNT_PROJECTS = ["DEMO", "DEMOPORTAL"];

/**
 * The sign-in accounts. An account whose name an unrelated active user
 * holds is skipped (display names are unique), not the whole seed.
 */
export async function seedAccounts(
  ctx: SeedContext,
  opts: {
    printPasswords: boolean;
    hashPassword: (password: string) => Promise<string>;
  }
): Promise<void> {
  const { tx, lines } = ctx;
  for (const account of DEMO_ACCOUNTS) {
    const email = `${account.name}@${ctx.emailDomain}`;
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    let userId = existing?.id;
    if (!userId) {
      if (await nameTaken(ctx, account.name)) {
        lines.push(`skipped ${account.name} (name taken)`);
        continue;
      }
      userId = Bun.randomUUIDv7();
      const password = ctx.newPassword();
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
        id: Bun.randomUUIDv7(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: await opts.hashPassword(password),
      });
      count(ctx, "users");
      lines.push(
        opts.printPasswords
          ? `created ${email} (${account.orgRole}) password: ${password}`
          : `created ${email} (${account.orgRole})`
      );
    } else {
      lines.push(`exists  ${email}`);
    }
    ctx.people.set(account.name, { id: userId, name: account.name });
    if (account.member) {
      const projectIds = ACCOUNT_PROJECTS.flatMap(
        (key) => ctx.projects.get(key)?.id ?? []
      );
      // Both demo projects may be skipped (held by real projects), and
      // drizzle refuses an empty values().
      if (projectIds.length === 0) continue;
      const added = await tx
        .insert(projectMembers)
        .values(projectIds.map((projectId) => ({ projectId, userId })))
        .onConflictDoNothing()
        .returning({ projectId: projectMembers.projectId });
      count(ctx, "projectMembers", added.length);
    }
  }
}

export async function seedStaff(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;
  const admin = ctx.people.get("demo-admin")?.id ?? null;
  for (const staff of DEMO_STAFF) {
    const email = `${staff.login}@${ctx.emailDomain}`;
    const [existing] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, email));
    let person = existing;
    if (!person) {
      // Active display names are unique (mentions resolve by name): leave
      // the person out rather than fail the whole seed on someone else's
      // account.
      if (await nameTaken(ctx, staff.name)) continue;
      const createdAt = addDays(ctx.now, -45);
      person = { id: Bun.randomUUIDv7(), name: staff.name };
      await tx.insert(users).values({
        id: person.id,
        name: staff.name,
        email,
        emailVerified: true,
        role: staff.orgRole,
        title: staff.title,
        timezone: STAFF_TIME_ZONE,
        workingHours: STAFF_WORKING_HOURS,
        createdAt,
        updatedAt: createdAt,
      });
      count(ctx, "users");
    }
    ctx.people.set(staff.handle as PersonRef, person);

    for (const [index, key] of staff.projects.entries()) {
      const project = ctx.projects.get(key);
      if (!project) continue;
      const createdAt = addMinutes(addDays(ctx.now, -34), index * 7);
      const added = await tx
        .insert(projectMembers)
        .values({ projectId: project.id, userId: person.id, createdAt })
        .onConflictDoNothing()
        .returning({ projectId: projectMembers.projectId });
      if (added.length === 0) continue;
      count(ctx, "projectMembers");
      // The same entry adding a member writes (server/services/project-members).
      await tx.insert(activityLog).values({
        actorId: admin,
        action: "member.added",
        entityType: "member",
        entityId: person.id,
        data: { user: person.name, project: project.name },
        createdAt,
      });
      count(ctx, "activity");
    }
  }
}

/** Whether an active user already has this display name (case-insensitive). */
async function nameTaken(ctx: SeedContext, name: string): Promise<boolean> {
  const [taken] = await ctx.tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.banned, false), sql`lower(${users.name}) = lower(${name})`)
    );
  return taken !== undefined;
}
