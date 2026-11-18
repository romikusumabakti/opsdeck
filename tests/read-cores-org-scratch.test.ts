import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import type { ServerView } from "@/lib/server-view";

// The issue, people, server and activity read cores (xxxFor(scope, …))
// against their session wrappers on a real Postgres, as
// tests/read-cores-scratch.test.ts does for environments and deploys: for an
// admin, an observer, an engineer member of one project, a qa user who is
// a member of nothing and a staff user who is a member of one project (and
// must still see none), each core given accessScopeForUser returns what the
// page's wrapper returns for that user's session, and refuses where the page
// refuses (same status, or the same emptiness). The
// local menara-postgres container (postgres 18) through its published port,
// with the superuser password read from the container and never printed; a
// scratch database is created, migrated and dropped.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/read-cores-org-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "read_cores_org_scratch";

const session = vi.hoisted(() => ({
  user: null as null | { id: string; role: string },
}));

vi.mock("@/lib/auth-session", async () => {
  const { HTTPException } = await import("hono/http-exception");
  const current = async () =>
    session.user
      ? { user: session.user, session: { signInMethod: "passkey" } }
      : null;
  return {
    getServerSession: current,
    requireSession: async () => {
      const s = await current();
      if (!s) throw new HTTPException(401, { message: "Unauthorized" });
      return s;
    },
  };
});

function psql(db: string, args: string[]) {
  return execFileSync(
    "podman",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected a row");
  return row;
}

/** The value, or the HTTP status it was refused with. */
async function outcome<T>(fn: () => Promise<T>) {
  try {
    return { value: await fn() };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status !== "number") throw error;
    return { status };
  }
}

describe.skipIf(!enabled)(
  "org and issue read cores match their session wrappers",
  () => {
    let client: ReturnType<typeof postgres>;
    let previousUrl: string | undefined;

    beforeAll(() => {
      const password = encodeURIComponent(
        execFileSync("podman", [
          "exec",
          CONTAINER,
          "printenv",
          "POSTGRES_PASSWORD",
        ])
          .toString()
          .trim()
      );
      const url = `postgres://postgres:${password}@127.0.0.1:5432/${DB_NAME}`;
      psql("postgres", [
        "-c",
        `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
        "-c",
        `CREATE DATABASE ${DB_NAME}`,
      ]);
      const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: url,
        },
      });
      if (result.status !== 0)
        throw new Error(`migrate failed: ${result.stderr}`);
      previousUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = url;
      client = postgres(url, { max: 1, onnotice: () => {} });
    });

    afterAll(async () => {
      await client?.end();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      psql("postgres", [
        "-c",
        `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      ]);
    });

    it("each core equals its wrapper for every role, refusals included", async () => {
      const d = drizzle({ client });
      const { accessScopeForUser, accessScopeFromSession } = await import(
        "@/lib/access-scope"
      );
      const issuesService = await import("@/server/services/issues");
      const people = await import("@/lib/people/queries");
      const members = await import("@/server/services/project-members");
      const serversService = await import("@/server/services/servers");
      const activity = await import("@/server/services/activity");
      // A Servers page row as SafeServer: drop what only the page shows.
      const pageToSafe = ({
        hostKeyFingerprint: _fingerprint,
        hostKeyPinnedAt: _pinnedAt,
        sshKeyId: _keyId,
        sshFrom: _from,
        keyError: _keyError,
        hasPassword: _hasPassword,
        hostKeyMismatch: _mismatch,
        offeredFingerprint: _offered,
        keyMarker: _marker,
        ...safe
      }: ServerView) => safe;

      const user = async (id: string, role: string, banned = false) =>
        one(
          await d
            .insert(schema.users)
            .values({
              id,
              name: role,
              email: `${role}@example.com`,
              role,
              banned,
            })
            .returning()
        );
      const admin = await user("00000000-0000-7000-8000-00000000c001", "admin");
      const observer = await user(
        "00000000-0000-7000-8000-00000000c002",
        "observer"
      );
      const engineer = await user(
        "00000000-0000-7000-8000-00000000c003",
        "engineer"
      );
      const qa = await user("00000000-0000-7000-8000-00000000c004", "qa");
      // A membership left over from an earlier role opens nothing to staff.
      const staff = await user("00000000-0000-7000-8000-00000000c006", "staff");
      // Deactivated: listed only for a role holding user:list.
      const gone = await user(
        "00000000-0000-7000-8000-00000000c005",
        "pm",
        true
      );

      // Two servers share a name; one stores a password and a pinned host key.
      const [s1, s2] = await d
        .insert(schema.servers)
        .values([
          {
            name: "app-1",
            host: "192.0.2.10",
            username: "deploy",
            password: "enc:not-a-real-secret",
            hostKeyType: "ssh-ed25519",
            hostKey: "AAAAC3NzaC1lZDI1NTE5AAAA",
            hostKeyFingerprint: "SHA256:example",
            sshFrom: "198.51.100.7",
          },
          { name: "twin", host: "192.0.2.11", username: "deploy" },
          { name: "twin", host: "192.0.2.12", username: "deploy" },
        ])
        .returning();
      if (!s1 || !s2) throw new Error("expected servers");

      const label = one(
        await d
          .insert(schema.labels)
          .values({ name: "scratch-label", color: "red" })
          .returning()
      );
      const seed = async (key: string) => {
        const project = one(
          await d.insert(schema.projects).values({ name: key, key }).returning()
        );
        const env = one(
          await d
            .insert(schema.environments)
            .values({ projectId: project.id, name: `${key} dev`, slug: "dev" })
            .returning()
        );
        const parent = one(
          await d
            .insert(schema.issues)
            .values({
              projectId: project.id,
              number: 1,
              title: `${key} login fails`,
              description: "stack trace here",
              environmentId: env.id,
              assigneeId: admin.id,
              createdById: admin.id,
            })
            .returning()
        );
        await d.insert(schema.issues).values([
          {
            projectId: project.id,
            number: 2,
            title: `${key} child`,
            parentId: parent.id,
            status: "resolved",
          },
          {
            projectId: project.id,
            number: 3,
            title: `${key} closed`,
            status: "closed",
          },
        ]);
        await d
          .insert(schema.issueLabels)
          .values({ issueId: parent.id, labelId: label.id });
        await d
          .insert(schema.issueComments)
          .values({ issueId: parent.id, authorId: admin.id, body: "seen" });
        return { project, env };
      };
      const p1 = await seed("ALPHA");
      const p2 = await seed("BETA");
      // The engineer and staff are members of the first project; qa of none.
      await d.insert(schema.projectMembers).values([
        { projectId: p1.project.id, userId: engineer.id },
        { projectId: p1.project.id, userId: staff.id },
      ]);
      await d.insert(schema.activityLog).values([
        {
          actorId: admin.id,
          action: "issue.created",
          data: { key: "ALPHA-1" },
        },
        { actorId: null, action: "member.added", data: { user: "x" } },
      ]);

      const everyone = [admin, observer, engineer, qa, staff];
      const seesP1 = new Set([admin.id, observer.id, engineer.id]);
      const seesP2 = new Set([admin.id, observer.id]);
      // member:manage: admin everywhere, the engineer on its own project.
      const managesMembers = new Set([admin.id]);
      const readsServers = new Set([admin.id, observer.id, engineer.id]);
      const readsAudit = new Set([admin.id, observer.id]);
      const listsUsers = new Set([admin.id, observer.id]);

      for (const person of everyone) {
        session.user = { id: person.id, role: person.role ?? "qa" };
        const scope = await accessScopeForUser(person.id);
        expect(scope).toEqual(await accessScopeFromSession());

        // Global Issues page: list, search, filters.
        for (const query of [
          {},
          { q: "login" },
          { q: "BETA-1" },
          { projectId: p2.project.id },
          { view: "board" as const },
          { labelId: label.id, sort: "key" as const, desc: false },
        ]) {
          const page = await issuesService.listAllIssuesFor(scope, query);
          expect(page).toEqual(await issuesService.listAllIssues(query));
          for (const row of page.rows) {
            const sees = row.projectId === p1.project.id ? seesP1 : seesP2;
            expect(sees.has(person.id)).toBe(true);
          }
        }
        expect(
          (await issuesService.listAllIssuesFor(scope, { view: "board" })).total
        ).toBe(3 * [seesP1, seesP2].filter((s) => s.has(person.id)).length);

        for (const { project } of [p1, p2]) {
          const sees = (project === p1.project ? seesP1 : seesP2).has(
            person.id
          );

          // Project Issues list: 404 when invisible.
          for (const statuses of [
            undefined,
            ["open", "in_progress"] as const,
          ]) {
            const list = await outcome(() =>
              issuesService.listIssuesFor(scope, project.id, statuses)
            );
            expect(list).toEqual(
              await outcome(() =>
                issuesService.listIssues(project.id, statuses)
              )
            );
            expect("status" in list ? list.status : 200).toBe(sees ? 200 : 404);
          }

          // Issue detail: null when invisible (as the page's 404).
          for (const number of [1, 2]) {
            const detail = await issuesService.getIssueDetailFor(
              scope,
              project.key.toLowerCase(),
              number
            );
            expect(detail).toEqual(
              await issuesService.getIssueDetail(project.key, number)
            );
            expect(detail === null).toBe(!sees);
          }

          // People filtered to the project: the page's project filter.
          const filtered = await outcome(() =>
            people.listPeopleFor(scope, project.id)
          );
          if (sees) {
            expect(filtered).toEqual({
              value: (await people.listPeople()).filter((p) =>
                p.projectIds.includes(project.id)
              ),
            });
          } else {
            expect(filtered).toEqual({ status: 404 });
          }

          // The project's Members page: member:manage.
          const memberList = await outcome(() =>
            members.listProjectMembersFor(scope, project.id)
          );
          expect(memberList).toEqual(
            await outcome(() => members.listProjectMembers(project.id))
          );
          const manages =
            managesMembers.has(person.id) ||
            (person.id === engineer.id && project === p1.project);
          expect("status" in memberList ? memberList.status : 200).toBe(
            manages ? 200 : sees ? 403 : 404
          );
        }
        // A non-uuid project id for the people filter is a 404, as invisible.
        await expect(
          people.listPeopleFor(scope, "not-a-uuid")
        ).rejects.toMatchObject({ status: 404 });
        // Unknown and non-uuid issue keys read as nothing.
        expect(
          await issuesService.getIssueDetailFor(scope, "NOPE", 1)
        ).toBeNull();
        await expect(
          issuesService.listIssuesFor(scope, "nope")
        ).rejects.toMatchObject({ status: 404 });

        // People page: everyone (emails included), deactivated users only for
        // user:list.
        const everybody = await people.listPeopleFor(scope);
        expect(everybody).toEqual(await people.listPeople());
        expect(everybody.some((p) => p.id === gone.id)).toBe(
          listsUsers.has(person.id)
        );
        expect(everybody.find((p) => p.id === admin.id)?.email).toBe(
          "admin@example.com"
        );

        // Servers: the page's rows, credential-free; 403 without server:read.
        const list = await outcome(() => serversService.getServersFor(scope));
        const page = await outcome(() => serversService.getServers());
        if (readsServers.has(person.id)) {
          // The same servers as the page, in its order (name ties aside),
          // minus every page field about how the Panel signs in.
          const byKey = (a: { id: string }, b: { id: string }) =>
            a.id.localeCompare(b.id);
          expect(list.value?.toSorted(byKey)).toEqual(
            page.value?.map(pageToSafe).toSorted(byKey)
          );
          expect(list.value?.map((r) => r.name)).toEqual(
            page.value?.map((r) => r.name)
          );
          for (const row of list.value ?? []) {
            for (const secret of [
              "password",
              "hostKey",
              "hostKeyType",
              "hostKeyFingerprint",
              "hostKeyPinnedAt",
              "hostKeyOfferedType",
              "hostKeyOffered",
              "hostKeyOfferedFingerprint",
              "sshKeyId",
              "sshFrom",
              "keyError",
            ]) {
              expect(row).not.toHaveProperty(secret);
            }
          }
          const byId = await serversService.getServerFor(scope, s1.id);
          const shown = await serversService.getServerById(s1.id);
          expect(byId).toEqual(shown && pageToSafe(shown));
          expect(await serversService.getServerFor(scope, "APP-1")).toEqual(
            byId
          );
          // A shared name is ambiguous; an unknown one finds nothing.
          expect(
            await serversService.getServerFor(scope, "twin")
          ).toBeUndefined();
          expect(
            await serversService.getServerFor(scope, "none")
          ).toBeUndefined();
        } else {
          expect(list).toEqual({ status: 403 });
          expect(page).toEqual({ status: 403 });
          await expect(
            serversService.getServerFor(scope, s1.id)
          ).rejects.toMatchObject({ status: 403 });
        }

        // Activity: org-wide, audit:read only.
        const feed = await outcome(() => activity.listActivityFor(scope, 100));
        expect(feed).toEqual(await outcome(() => activity.listActivity(100)));
        expect("status" in feed ? feed.status : 200).toBe(
          readsAudit.has(person.id) ? 200 : 403
        );
      }

      // Seen by an admin, staff holds no project: not on the People page, not
      // on its own card, not as an assignee or environment owner.
      session.user = { id: admin.id, role: "admin" };
      const usersService = await import("@/server/services/users");
      const staffRow = (await people.listPeople()).find(
        (p) => p.id === staff.id
      );
      expect(staffRow?.projectIds).toEqual([]);
      expect(await people.getPersonProjects(staff.id)).toEqual([]);
      expect(
        (await people.getPersonProjects(engineer.id)).map((p) => p.id)
      ).toEqual([p1.project.id]);
      const assignable = await usersService.listAssignableUsers(p1.project.id);
      expect(assignable.map((u) => u.id)).toContain(engineer.id);
      expect(assignable.map((u) => u.id)).not.toContain(staff.id);
      expect(
        (await usersService.listAssignableUsersAcrossProjects()).map(
          (u) => u.id
        )
      ).not.toContain(staff.id);

      // The migrated column defaults: a row written without a role is staff.
      const unassigned = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c007",
            name: "unassigned",
            email: "unassigned@example.com",
          })
          .returning()
      );
      expect(unassigned.role).toBe("staff");
      const [rawUser] = await client`
        insert into users (id, name, email)
        values ('00000000-0000-7000-8000-00000000c008', 'raw', 'raw@example.com')
        returning role`;
      expect(rawUser?.role).toBe("staff");
      const [rawInvite] = await client`
        insert into invitations (email, name, token, expires_at)
        values ('invitee@example.com', 'invitee', 'scratch-token', now() + interval '1 day')
        returning role`;
      expect(rawInvite?.role).toBe("staff");

      // The activity limit is clamped server-side.
      const scope = await accessScopeForUser(admin.id);
      expect(await activity.listActivityFor(scope, 1)).toHaveLength(1);
      expect(await activity.listActivityFor(scope, 0)).toHaveLength(1);
      expect(await activity.listActivityFor(scope, 10_000)).toHaveLength(2);
    });
  }
);
