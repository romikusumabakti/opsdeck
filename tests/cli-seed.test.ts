import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_ACCOUNTS,
  runSeed,
  type SeedOptions,
  SeedRefusedError,
  seedDemo,
} from "@/scripts/cli/seed";
import { DEMO_PROJECTS } from "@/scripts/cli/seed-data/catalog";
import {
  planBuilds,
  planDeployments,
  plannedTargets,
} from "@/scripts/cli/seed-data/deploys";
import {
  ORIGINAL_ISSUES,
  PROJECT_ISSUES,
} from "@/scripts/cli/seed-data/issues";
import { DEMO_STAFF } from "@/scripts/cli/seed-data/people";

// The seed against a real Postgres: a throwaway database made in the local
// menara-postgres container (superuser password read from the container,
// never printed) and dropped afterwards.
//
//   SEED_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/cli-seed.test.ts
const enabled = process.env.SEED_SCRATCH === "1";

describe("menara seed demo arguments", () => {
  it("rejects an unknown subcommand or flag", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(await runSeed(["nope"])).toBe(1);
      expect(await runSeed(["demo", "--bogus"])).toBe(1);
    } finally {
      console.error = original;
    }
  });
});

// The fixed end of the demo history in these tests.
const NOW = new Date("2026-11-16T08:00:00Z");

describe("demo deploy history plan", () => {
  const host = (p: { defaultServer: string }) => p.defaultServer;
  const builds = planBuilds(NOW, "example.invalid");
  const deployments = planDeployments(NOW, builds, plannedTargets(), host);

  it("is deterministic", () => {
    expect(planBuilds(NOW, "example.invalid")).toEqual(builds);
    expect(planDeployments(NOW, builds, plannedTargets(), host)).toEqual(
      deployments
    );
  });

  it("plans fake 40-hex commits and unique tags per component", () => {
    expect(builds.every((b) => /^[0-9a-f]{40}$/.test(b.commitSha))).toBe(true);
    const tags = builds.map((b) => `${b.componentKey} ${b.tag}`);
    expect(new Set(tags).size).toBe(tags.length);
    expect(
      builds.every((b) => b.commitAuthorEmail.endsWith("@example.invalid"))
    ).toBe(true);
  });

  it("ends every deployment, in the 30 days before now", () => {
    expect(deployments.length).toBeGreaterThan(0);
    const start = NOW.getTime() - 31 * 24 * 3600_000;
    for (const d of deployments) {
      expect(["success", "failed"]).toContain(d.status);
      expect(d.finishedAt.getTime()).toBeLessThan(NOW.getTime());
      expect(d.createdAt.getTime()).toBeGreaterThan(start);
      expect(d.startedAt <= d.scriptStartedAt).toBe(true);
      expect(d.scriptStartedAt <= d.finishedAt).toBe(true);
    }
    expect(deployments.some((d) => d.status === "failed")).toBe(true);
    expect(deployments.some((d) => d.trigger === "rollback")).toBe(true);
    // The last word on every target is a success.
    const lastByTarget = new Map<string, string>();
    for (const d of deployments) {
      lastByTarget.set(`${d.projectKey} ${d.slug} ${d.componentKey}`, d.status);
    }
    expect(lastByTarget.size).toBe(plannedTargets().length);
    expect([...lastByTarget.values()].every((s) => s === "success")).toBe(true);
  });
});

describe.skipIf(!enabled)("menara seed demo on a real Postgres", () => {
  const dbName = `seed_${randomBytes(4).toString("hex")}`;
  const password = enabled
    ? encodeURIComponent(
        execFileSync("podman", [
          "exec",
          "menara-postgres",
          "printenv",
          "POSTGRES_PASSWORD",
        ])
          .toString()
          .trim()
      )
    : "";
  const base = `postgres://postgres:${password}@127.0.0.1:5432`;
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  const lines: string[] = [];
  const options = (over: Partial<SeedOptions> = {}): SeedOptions => ({
    printPasswords: false,
    force: false,
    nodeEnv: "test",
    hashPassword: async (p) => `hash:${p}`,
    encryptSecret: (p) => `enc:v1:${p.length}`,
    out: (l) => lines.push(l),
    now: NOW,
    ...over,
  });
  const accountLines = () =>
    lines.filter((l) => l.startsWith("created") || l.startsWith("exists"));

  const counts = async () => {
    const [row] = await sql`
      select
        (select count(*) from projects)::int as projects,
        (select count(*) from project_groups)::int as "projectGroups",
        (select count(*) from environments)::int as environments,
        (select count(*) from servers)::int as servers,
        (select count(*) from issues)::int as issues,
        (select count(*) from users)::int as users,
        (select count(*) from accounts)::int as accounts,
        (select count(*) from project_members)::int as members,
        (select count(*) from apps)::int as apps,
        (select count(*) from app_components)::int as components,
        (select count(*) from ci_connections)::int as ci,
        (select count(*) from project_apps)::int as "projectApps",
        (select count(*) from project_component_branches)::int as branches,
        (select count(*) from deploy_targets)::int as targets,
        (select count(*) from builds)::int as builds,
        (select count(*) from deployments)::int as deployments,
        (select count(*) from runs)::int as runs,
        (select count(*) from labels)::int as labels,
        (select count(*) from issue_labels)::int as "issueLabels",
        (select count(*) from milestones)::int as milestones,
        (select count(*) from issue_comments)::int as comments,
        (select count(*) from notifications)::int as notifications,
        (select count(*) from activity_log)::int as activity,
        (select count(*) from knowledge_collections)::int as collections,
        (select count(*) from knowledge_documents)::int as documents,
        (select count(*) from knowledge_revisions)::int as revisions,
        (select count(*) from knowledge_links)::int as links`;
    return row as Record<string, number>;
  };
  let first: Record<string, number>;

  beforeAll(async () => {
    await admin.unsafe(`create database ${dbName}`);
    sql = postgres(`${base}/${dbName}`, {
      max: 2,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    db = drizzle({ client: sql });
    await migrate(db, { migrationsFolder: "drizzle" });
    // Rows that exist before seeding: a real project under the DEMO key
    // (with a Dev environment without an app and a real DEMO-1), a real
    // NPMB, DEMOPORTAL as the first seed wrote it (no client, its 4 sample
    // issues: demo data), a
    // real collection named like a demo one, and someone else already
    // called Joko Santoso.
    await sql`insert into projects (key, name) values ('DEMO', 'Customer Demo')`;
    await sql`
      insert into projects (key, name, client)
      values ('NPMB', 'Membership (in-house)', 'In-house')`;
    await sql`insert into projects (key, name) values ('DEMOPORTAL', 'Demo Portal')`;
    for (const issue of ORIGINAL_ISSUES) {
      await sql`
        insert into issues (project_id, number, title, status, type, priority)
        select id, ${issue.number}, ${issue.title}, ${issue.status}, ${issue.type}, ${issue.priority}
        from projects where key = 'DEMOPORTAL'`;
    }
    await sql`
      insert into knowledge_collections (name, description, rank)
      values ('Catatan Teknis', 'Our own notes', 'a0')`;
    await sql`
      insert into environments (project_id, name, slug, kind)
      select id, 'Dev', 'dev', 'dev' from projects where key = 'DEMO'`;
    await sql`
      insert into issues (project_id, number, title, description)
      select id, 1, 'A real issue', 'kept' from projects where key = 'DEMO'`;
    await sql`
      insert into users (id, name, email, role)
      values (uuidv7(), 'Joko Santoso', 'joko@other.invalid', 'engineer')`;
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it("seeds every area on the first run", async () => {
    lines.length = 0;
    const inserted = await seedDemo(db, options({ printPasswords: true }));
    first = await counts();
    const newIssues = Object.values(PROJECT_ISSUES).flat().length;
    expect(newIssues).toBe(45);
    expect(first).toMatchObject({
      projects: 5,
      // The two projects created now (NPCP, BSAC) bring their groups.
      projectGroups: 2,
      // DEMO keeps its own Dev; NPMB gets none; the other 3 × 3.
      environments: 10,
      servers: 3,
      // 7 sign-in accounts, 9 staff (Joko's name was taken), 1 pre-existing.
      users: 17,
      accounts: 7,
      // demo-engineer, demo-qa and demo-ba in DEMOPORTAL, staff in NPCP/BSAC (11).
      members: 14,
      apps: 3,
      components: 5,
      ci: 1,
      projectApps: 3,
      branches: 5,
      targets: 15,
      // DEMO-1 (real) + DEMOPORTAL 8 + NPCP and BSAC 15 each.
      issues: 39,
      labels: 9,
      milestones: 4,
      // Panduan Operasional (4 documents) is seeded; the real Catatan Teknis
      // gets none of its 3.
      collections: 2,
      documents: 4,
      revisions: 1,
      links: 2,
    });
    expect(first.builds).toBe(66);
    expect(first.deployments).toBeGreaterThan(40);
    expect(first.runs).toBe(first.deployments);
    expect(first.comments).toBeGreaterThan(30);
    expect(first.issueLabels).toBeGreaterThan(30);
    expect(first.notifications).toBeGreaterThan(0);
    expect(first.activity).toBeGreaterThan(40);
    expect(inserted.projects).toBe(2);
    expect(inserted.projectGroups).toBe(2);
    const filed = await sql`
      select p.key, g.name as "group" from projects p
      left join project_groups g on g.id = p.group_id order by p.key`;
    expect(filed).toEqual([
      { key: "BSAC", group: "Dana Pensiun Bahari Sejahtera" },
      // Rows the seed did not create keep no group.
      { key: "DEMO", group: null },
      { key: "DEMOPORTAL", group: null },
      { key: "NPCP", group: "DPLK Nusantara Pensiun" },
      { key: "NPMB", group: null },
    ]);
    const ranks = await sql`select rank from project_groups order by rank`;
    expect(new Set(ranks.map((r) => r.rank)).size).toBe(2);
    expect(inserted.issues).toBe(34);
    expect(lines).toEqual(
      expect.arrayContaining([
        "skipped DEMO (not demo data)",
        "skipped NPMB (not demo data)",
        'skipped collection "Catatan Teknis" (not demo data)',
      ])
    );
    expect(lines.filter((l) => l.startsWith("skipped"))).toHaveLength(3);
    expect(accountLines()).toHaveLength(7);
    expect(
      accountLines().every(
        (l) => l.startsWith("created") && l.includes("password: ")
      )
    ).toBe(true);
    expect(lines.at(-1)).toMatch(/^demo data added: .*issues 34/);
  });

  it("inserts nothing on a second run", async () => {
    lines.length = 0;
    const inserted = await seedDemo(db, options({ printPasswords: true }));
    expect(await counts()).toEqual(first);
    expect(Object.values(inserted).every((n) => n === 0)).toBe(true);
    expect(accountLines()).toHaveLength(7);
    expect(
      accountLines().every(
        (l) => l.startsWith("exists") && !l.includes("password")
      )
    ).toBe(true);
    expect(lines.at(-1)).toBe("demo data added: nothing (already present)");
    // A later clock plans different times, but still nothing new.
    await seedDemo(db, options({ now: new Date("2026-12-24T08:00:00Z") }));
    expect(await counts()).toEqual(first);
  });

  it("leaves pre-existing rows untouched", async () => {
    const [demo] = await sql`
      select name, client, description, default_server_id from projects where key = 'DEMO'`;
    expect(demo).toEqual({
      name: "Customer Demo",
      client: null,
      description: null,
      default_server_id: null,
    });
    const [issue] = await sql`
      select i.id, i.title, i.description, i.assignee_id, i.created_by_id
      from issues i join projects p on p.id = i.project_id
      where p.key = 'DEMO' and i.number = 1`;
    expect(issue).toMatchObject({
      title: "A real issue",
      description: "kept",
      assignee_id: null,
      created_by_id: null,
    });
    const [attached] = await sql`
      select
        (select count(*) from issue_comments where issue_id = ${issue?.id})::int as comments,
        (select count(*) from issue_labels where issue_id = ${issue?.id})::int as labels`;
    expect(attached).toEqual({ comments: 0, labels: 0 });
    const [dev] = await sql`
      select e.id, e.app_id, e.url from environments e
      join projects p on p.id = e.project_id where p.key = 'DEMO' and e.slug = 'dev'`;
    expect(dev).toMatchObject({ app_id: null, url: null });
    const [{ n }] = (await sql`
      select count(*)::int as n from deploy_targets where environment_id = ${dev?.id}`) as unknown as [
      { n: number },
    ];
    expect(n).toBe(0);
    const joko =
      await sql`select email, role from users where name = 'Joko Santoso'`;
    expect(joko).toEqual([{ email: "joko@other.invalid", role: "engineer" }]);
  });

  it("adds nothing under projects and collections the seed does not own", async () => {
    for (const key of ["DEMO", "NPMB"]) {
      const [row] = await sql`
        select
          (select count(*) from environments e where e.project_id = p.id)::int as environments,
          (select count(*) from issues i where i.project_id = p.id)::int as issues,
          (select count(*) from project_apps a where a.project_id = p.id)::int as sources,
          (select count(*) from project_component_branches b where b.project_id = p.id)::int as branches,
          (select count(*) from project_members m where m.project_id = p.id)::int as members,
          (select count(*) from milestones m where m.project_id = p.id)::int as milestones,
          (select count(*) from knowledge_documents d where d.project_id = p.id)::int as documents,
          p.name, p.client, p.default_server_id
        from projects p where p.key = ${key}`;
      expect(row).toEqual(
        key === "DEMO"
          ? {
              environments: 1,
              issues: 1,
              sources: 0,
              branches: 0,
              members: 0,
              milestones: 0,
              documents: 0,
              name: "Customer Demo",
              client: null,
              default_server_id: null,
            }
          : {
              environments: 0,
              issues: 0,
              sources: 0,
              branches: 0,
              members: 0,
              milestones: 0,
              documents: 0,
              name: "Membership (in-house)",
              client: "In-house",
              default_server_id: null,
            }
      );
    }
    // DEMOPORTAL as the first seed wrote it is demo data: it is filled in
    // (its own row stays as it was).
    const [portal] = await sql`
      select p.client,
        (select count(*) from environments e where e.project_id = p.id)::int as environments,
        (select count(*) from issues i where i.project_id = p.id)::int as issues
      from projects p where p.key = 'DEMOPORTAL'`;
    expect(portal).toEqual({ client: null, environments: 3, issues: 8 });
    const [collection] = await sql`
      select c.description,
        (select count(*) from knowledge_documents d where d.collection_id = c.id)::int as documents
      from knowledge_collections c where c.name = 'Catatan Teknis'`;
    expect(collection).toEqual({ description: "Our own notes", documents: 0 });
  });

  it("numbers issues uniquely and contiguously per project", async () => {
    const dupes = await sql`
      select project_id, number from issues group by project_id, number having count(*) > 1`;
    expect(dupes).toHaveLength(0);
    const perProject = await sql`
      select p.key, count(*)::int as n, max(i.number)::int as max
      from issues i join projects p on p.id = i.project_id group by p.key`;
    for (const row of perProject) expect(row.max).toBe(row.n);
    const parents = await sql`
      select c.project_id from issues c join issues p on p.id = c.parent_id
      where p.project_id <> c.project_id`;
    expect(parents).toHaveLength(0);
    const children =
      await sql`select count(*)::int as n from issues where parent_id is not null`;
    expect(children[0]?.n).toBeGreaterThanOrEqual(4);
  });

  it("leaves no queued or running deploys, only finished history", async () => {
    const open = await sql`
      select status from deployments where status not in ('success', 'failed')`;
    expect(open).toHaveLength(0);
    const started =
      await sql`select id from runs where status = 'started' or completed_at is null`;
    expect(started).toHaveLength(0);
    const mismatched = await sql`
      select d.id from deployments d join runs r on r.id = d.run_id
      where r.status::text <> d.status::text or r.kind <> 'deploy'
        or d.finished_at > ${NOW} or d.build_id is null`;
    expect(mismatched).toHaveLength(0);
    const orphans = await sql`select id from deployments where run_id is null`;
    expect(orphans).toHaveLength(0);
    const wrongApp = await sql`
      select t.id from deploy_targets t
      join environments e on e.id = t.environment_id
      join app_components c on c.component_key = t.component_key
      where e.app_id is distinct from c.app_id or t.auto_deploy`;
    expect(wrongApp).toHaveLength(0);
  });

  it("uses only fictional addresses, and staff cannot sign in", async () => {
    const emails =
      await sql`select email from users where email <> 'joko@other.invalid'`;
    expect(emails.every((u) => u.email.endsWith("@example.invalid"))).toBe(
      true
    );
    const staff = await sql`
      select u.email from users u join accounts a on a.user_id = u.id
      where u.email not like 'demo-%'`;
    expect(staff).toHaveLength(0);
    expect(DEMO_STAFF).toHaveLength(10);
    const hosts = await sql`select host from servers`;
    expect(hosts.every((h) => h.host.endsWith(".invalid"))).toBe(true);
    const repos = await sql`select repo_full_name from app_components`;
    expect(repos.every((r) => r.repo_full_name.startsWith("demo-org/"))).toBe(
      true
    );
    const projects = await sql`select key from projects order by key`;
    expect(projects.map((p) => p.key).sort()).toEqual(
      DEMO_PROJECTS.map((p) => p.key).sort()
    );
  });

  it("never prints passwords without --print-passwords", async () => {
    await sql`delete from users where email = 'demo-qa@example.invalid'`;
    lines.length = 0;
    await seedDemo(db, options());
    expect(accountLines().filter((l) => l.startsWith("created"))).toEqual([
      "created demo-qa@example.invalid (qa)",
    ]);
  });

  it("prints passwords only once the transaction commits", async () => {
    await sql`delete from users where email in ('demo-engineer@example.invalid', 'demo-qa@example.invalid')`;
    lines.length = 0;
    let hashed = 0;
    await expect(
      seedDemo(
        db,
        options({
          printPasswords: true,
          hashPassword: async (p) => {
            hashed += 1;
            if (hashed === 2) throw new Error("hash failed");
            return `hash:${p}`;
          },
        })
      )
    ).rejects.toThrow("hash failed");
    // The first account was created inside the rolled-back transaction: its
    // password was never printed, and the account does not exist.
    expect(lines).toEqual([]);
    const [{ n }] =
      (await sql`select count(*)::int as n from users where email in ('demo-engineer@example.invalid', 'demo-qa@example.invalid')`) as unknown as [
        { n: number },
      ];
    expect(n).toBe(0);
    await seedDemo(db, options());
  });

  it("keeps the roles and memberships exactly as specified", async () => {
    const roles =
      await sql`select email, role from users where email like 'demo-%' order by email`;
    expect(Object.fromEntries(roles.map((r) => [r.email, r.role]))).toEqual({
      "demo-admin@example.invalid": "admin",
      "demo-infra@example.invalid": "infra",
      "demo-observer@example.invalid": "observer",
      "demo-engineer@example.invalid": "engineer",
      "demo-qa@example.invalid": "qa",
      "demo-ba@example.invalid": "ba",
      "demo-staff@example.invalid": "staff",
    });
    const members = await sql`
      select u.email, p.key from project_members m
      join users u on u.id = m.user_id join projects p on p.id = m.project_id
      where u.email like 'demo-%'`;
    // DEMO here is a real project, so only DEMOPORTAL.
    expect(members).toHaveLength(3);
    for (const name of ["demo-engineer", "demo-qa", "demo-ba"]) {
      const mine = members.filter((m) => m.email === `${name}@example.invalid`);
      expect(mine.map((m) => m.key)).toEqual(["DEMOPORTAL"]);
    }
    expect(DEMO_ACCOUNTS).toHaveLength(7);
    const credential = await sql`select provider_id from accounts`;
    expect(credential.every((a) => a.provider_id === "credential")).toBe(true);
  });

  it("creates only unreachable placeholder servers, and mixed issue statuses", async () => {
    const rows = await sql`select host, placement from servers`;
    expect(rows).toHaveLength(3);
    expect(
      rows.every((r) => r.host.endsWith(".invalid") && r.placement === "open")
    ).toBe(true);
    const statuses = await sql`select distinct status from issues`;
    expect(statuses.length).toBeGreaterThan(1);
  });

  it("completes when both demo projects are real, hand-made ones", async () => {
    // A database of its own: DEMO is someone's project, and DEMOPORTAL a
    // hand-made "Demo Portal" with no client, no demo app and no sample
    // issues, which must not pass for the first seed's.
    const otherName = `${dbName}_b`;
    await admin.unsafe(`create database ${otherName}`);
    const other = postgres(`${base}/${otherName}`, {
      max: 2,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    try {
      const otherDb = drizzle({ client: other });
      await migrate(otherDb, { migrationsFolder: "drizzle" });
      await other`insert into projects (key, name) values ('DEMO', 'Customer Demo')`;
      await other`insert into projects (key, name) values ('DEMOPORTAL', 'Demo Portal')`;
      await other`
        insert into issues (project_id, number, title)
        select id, 1, 'Our first issue' from projects where key = 'DEMOPORTAL'`;
      lines.length = 0;
      await seedDemo(otherDb, options());
      expect(lines).toEqual(
        expect.arrayContaining([
          "skipped DEMO (not demo data)",
          "skipped DEMOPORTAL (not demo data)",
        ])
      );
      const accounts = await other`
        select u.email, count(m.project_id)::int as memberships
        from users u left join project_members m on m.user_id = u.id
        where u.email like 'demo-%' group by u.email`;
      expect(accounts).toHaveLength(7);
      expect(accounts.every((a) => a.memberships === 0)).toBe(true);
      const [row] = await other`
        select
          (select count(*) from environments e join projects p on p.id = e.project_id
            where p.key in ('DEMO', 'DEMOPORTAL'))::int as environments,
          (select count(*) from issues i join projects p on p.id = i.project_id
            where p.key in ('DEMO', 'DEMOPORTAL'))::int as issues,
          (select count(*) from projects)::int as projects`;
      expect(row).toEqual({ environments: 0, issues: 1, projects: 5 });
    } finally {
      await other.end();
      await admin.unsafe(`drop database if exists ${otherName} with (force)`);
    }
  });

  it("skips a demo account whose name someone else holds", async () => {
    await sql`delete from users where email = 'demo-observer@example.invalid'`;
    await sql`
      insert into users (id, name, email, role)
      values (uuidv7(), 'Demo-Observer', 'observer@other.invalid', 'observer')`;
    lines.length = 0;
    await seedDemo(db, options());
    expect(lines).toContain("skipped demo-observer (name taken)");
    const rows =
      await sql`select email from users where lower(name) = 'demo-observer'`;
    expect(rows).toEqual([{ email: "observer@other.invalid" }]);
    await sql`delete from users where email = 'observer@other.invalid'`;
    await seedDemo(db, options());
  });

  it("refuses on a stable channel in production, unless forced", async () => {
    await expect(
      seedDemo(db, options({ nodeEnv: "production" }))
    ).rejects.toBeInstanceOf(SeedRefusedError);
    await seedDemo(db, options({ nodeEnv: "production", force: true }));

    await sql`update instance_settings set update_channel = 'beta' where id = 1`;
    await seedDemo(db, options({ nodeEnv: "production" }));
    await sql`update instance_settings set update_channel = 'stable' where id = 1`;
  });
});
