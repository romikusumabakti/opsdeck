import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { parseImportArgs } from "@/scripts/cli/knowledge";
import {
  type ImportOptions,
  importKnowledge,
  parseImportFile,
  rewriteImportLinks,
} from "@/scripts/cli/knowledge-import";

// `menara knowledge import` — the front matter and link rules alone, then the
// whole import against a real Postgres: the local menara-postgres container,
// a scratch database migrated with `menara migrate` and dropped afterwards
// (superuser password read from the container, never printed).
//
//   KNOWLEDGE_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/cli-knowledge-import.test.ts
const enabled = process.env.KNOWLEDGE_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "knowledge_import_scratch";

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const none = async () => null;
  return { requireSession: none, getServerSession: none };
});

const file = (meta: string, body = "Body.") => `---\n${meta}\n---\n${body}\n`;

describe("knowledge import arguments", () => {
  it("parses the folder and flags", () => {
    expect(
      parseImportArgs(["import", "notes", "--as", "a@example.com"])
    ).toEqual({
      folder: "notes",
      asEmail: "a@example.com",
      dryRun: false,
      updateVisibility: false,
    });
    expect(
      parseImportArgs([
        "import",
        "--dry-run",
        "notes",
        "--update-visibility",
        "--as",
        "a@example.com",
      ])
    ).toMatchObject({ dryRun: true, updateVisibility: true });
  });

  it("refuses a missing folder, a missing --as or an unknown flag", () => {
    expect(parseImportArgs(["import", "--as", "a@example.com"])).toBeNull();
    expect(parseImportArgs(["import", "notes"])).toBeNull();
    expect(parseImportArgs(["import", "notes", "--as"])).toBeNull();
    expect(
      parseImportArgs(["import", "notes", "--as", "a@example.com", "--bogus"])
    ).toBeNull();
    expect(parseImportArgs(["export", "notes", "--as", "x"])).toBeNull();
  });
});

describe("knowledge import front matter", () => {
  it("reads collection, title, slug, docType and visibleTo", () => {
    const parsed = parseImportFile(
      "host-map.md",
      file(
        "collection: Platform Notes\ntitle: Host map\nslug: host-map\ndocType: runbook\nvisibleTo: [qa, infra, qa]",
        "# Hosts\n\nText."
      )
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.doc).toEqual({
      file: "host-map.md",
      collection: "Platform Notes",
      title: "Host map",
      slug: "host-map",
      docType: "runbook",
      visibleTo: ["infra", "qa"],
      body: "# Hosts\n\nText.",
    });
  });

  it("defaults the slug to the title's, docType to doc and leaves visibleTo undeclared", () => {
    const parsed = parseImportFile(
      "a.md",
      file("collection: Team Guides\ntitle: Deploy Flow")
    );
    expect(parsed.doc).toMatchObject({
      slug: "deploy-flow",
      docType: "doc",
      visibleTo: undefined,
    });
    // A key present with an empty list declares "everyone".
    expect(
      parseImportFile(
        "a.md",
        file("collection: Team Guides\ntitle: Deploy Flow\nvisibleTo: []")
      ).doc?.visibleTo
    ).toEqual([]);
  });

  it("reports every problem in a file", () => {
    const problems = (text: string) => parseImportFile("x.md", text).problems;
    expect(problems("# no front matter")).toEqual([
      "x.md: no YAML front matter (--- … --- at the top)",
    ]);
    expect(problems(file("title: [unclosed"))[0]).toMatch(
      /^x\.md: invalid YAML front matter/
    );
    expect(
      problems(
        file(
          "collection: ''\nslug: Not A Slug\ndocType: memo\nvisibleTo: [infra, nfra, admin]\nvisibleto: [qa]"
        )
      )
    ).toEqual([
      'x.md: unknown front matter key "visibleto"',
      "x.md: collection is required",
      "x.md: title is required",
      "x.md: slug must be lowercase letters, digits and single hyphens",
      "x.md: docType must be one of doc, runbook, spec, requirement",
      'x.md: visibleTo has an unknown role "nfra"',
      'x.md: visibleTo cannot list "admin" (admins always see every collection)',
    ]);
    expect(problems(file("collection: A\ntitle: B\nvisibleTo: infra"))).toEqual(
      ["x.md: visibleTo must be a list of roles"]
    );
  });
});

describe("knowledge import link rewriting", () => {
  const slugs = new Map([
    ["deploy-flow.md", "deploy-flow"],
    ["host-map.md", "hosts"],
  ]);

  it("points links to imported files at their documents", () => {
    expect(
      rewriteImportLinks(
        "See [the flow](deploy-flow.md), [hosts](./host-map.md#ssh) and [again](host-map.md).",
        slugs
      )
    ).toBe(
      "See [the flow](/knowledge/deploy-flow), [hosts](/knowledge/hosts) and [again](/knowledge/hosts)."
    );
  });

  it("leaves external, unknown, image and code links alone", () => {
    const body = [
      "[web](https://example.com/host-map.md)",
      "[outside](../other/host-map.md)",
      "[unknown](missing.md)",
      "![diagram](host-map.md)",
      "`[inline](host-map.md)`",
      "```",
      "[fenced](host-map.md)",
      "```",
    ].join("\n");
    expect(rewriteImportLinks(body, slugs)).toBe(body);
  });
});

// --- Against Postgres -------------------------------------------------------

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

const ADMIN = "00000000-0000-7000-8000-00000000d001";
const ENGINEER = "00000000-0000-7000-8000-00000000d002";
const BANNED = "00000000-0000-7000-8000-00000000d003";

describe.skipIf(!enabled)("menara knowledge import on Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let d: ReturnType<typeof drizzle>;
  let previousUrl: string | undefined;
  const root = mkdtempSync(join(tmpdir(), "kb-import-"));
  let out: string[] = [];
  let err: string[] = [];

  const folder = (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [n, text] of Object.entries(files)) {
      writeFileSync(join(dir, n), text);
    }
    return dir;
  };
  const run = (dir: string, over: Partial<ImportOptions> = {}) => {
    out = [];
    err = [];
    return importKnowledge({
      folder: dir,
      asEmail: "admin@example.com",
      dryRun: false,
      updateVisibility: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...over,
    });
  };
  const counts = async () => {
    const [row] = await client`
      select
        (select count(*) from knowledge_collections)::int as collections,
        (select count(*) from knowledge_documents)::int as documents,
        (select count(*) from knowledge_revisions)::int as revisions,
        (select count(*) from knowledge_links)::int as links`;
    return row as {
      collections: number;
      documents: number;
      revisions: number;
      links: number;
    };
  };
  const docBySlug = async (slug: string) => {
    const [row] = await d
      .select()
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.slug, slug));
    if (!row) throw new Error(`no document ${slug}`);
    return row;
  };
  const collectionByName = async (name: string) => {
    const [row] = await d
      .select()
      .from(schema.knowledgeCollections)
      .where(eq(schema.knowledgeCollections.name, name));
    if (!row) throw new Error(`no collection ${name}`);
    return row;
  };

  const guides = {
    "deploy-flow.md": file(
      "collection: Team Guides\ntitle: Deploy Flow\nvisibleTo: []",
      "Deploys go through the panel. Hosts: [map](host-map.md#lan)."
    ),
    "branches.md": file(
      "collection: Team Guides\ntitle: Branches\ndocType: runbook",
      "Merge main first, then read [the flow](deploy-flow.md) and [the docs](https://example.com/x.md)."
    ),
    "host-map.md": file(
      "collection: Platform Notes\ntitle: Host Map\nslug: hosts\nvisibleTo: [infra]",
      "sandbox-1.invalid runs the stack."
    ),
  };

  // deploy-flow.md as the update test edits it (and later tests keep it).
  const editedFlow = {
    "deploy-flow.md": file(
      "collection: Team Guides\ntitle: Deploy Flow\ndocType: runbook",
      "Deploys go through the panel, never by hand."
    ),
  };

  beforeAll(async () => {
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
    d = drizzle({ client });
    await d.insert(schema.users).values([
      { id: ADMIN, name: "Admin", email: "admin@example.com", role: "admin" },
      {
        id: ENGINEER,
        name: "Engineer",
        email: "engineer@example.com",
        role: "engineer",
      },
      {
        id: BANNED,
        name: "Former",
        email: "former@example.com",
        role: "admin",
        banned: true,
      },
    ]);
    // An existing collection with a document of its own.
    const [existing] = await d
      .insert(schema.knowledgeCollections)
      .values({ name: "Archive", rank: "a0" })
      .returning();
    if (!existing) throw new Error("no collection");
    await d.insert(schema.knowledgeDocuments).values({
      collectionId: existing.id,
      title: "Old Notes",
      slug: "old-notes",
      content: "old",
      contentText: "old",
      rank: "a0",
      publishedAt: new Date(),
      createdById: ADMIN,
    });
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses an --as user who is unknown, banned or cannot manage knowledge", async () => {
    const dir = folder("guides", guides);
    const before = await counts();
    expect(await run(dir, { asEmail: "nobody@example.com" })).toBe(1);
    expect(err).toContain('--as: no user with the email "nobody@example.com"');
    expect(await run(dir, { asEmail: "former@example.com" })).toBe(1);
    expect(err).toContain("--as: former@example.com is deactivated");
    expect(await run(dir, { asEmail: "Engineer@Example.com" })).toBe(1);
    expect(err).toContain(
      "--as: engineer@example.com (engineer) does not hold knowledge:manage"
    );
    expect(await counts()).toEqual(before);
  });

  it("prints the plan on a dry run and writes nothing", async () => {
    const dir = folder("guides", guides);
    const before = await counts();
    expect(await run(dir, { dryRun: true })).toBe(0);
    expect(out).toEqual([
      'create collection "Team Guides" (visible to everyone)',
      'create collection "Platform Notes" (visible to infra)',
      "created branches.md → branches",
      "created deploy-flow.md → deploy-flow",
      "created host-map.md → hosts",
      "dry run: 3 created, 0 updated, 0 unchanged, 0 refused (nothing written)",
    ]);
    expect(await counts()).toEqual(before);
  });

  it("creates collections and published, flat documents with rewritten links", async () => {
    const dir = folder("guides", guides);
    const before = await counts();
    expect(await run(dir)).toBe(0);
    expect(err).toEqual([]);
    expect(out.at(-1)).toBe(
      "imported: 3 created, 0 updated, 0 unchanged, 0 refused"
    );
    expect(await counts()).toEqual({
      ...before,
      collections: before.collections + 2,
      documents: before.documents + 3,
      // branches → deploy-flow, deploy-flow → hosts.
      links: before.links + 2,
    });

    const team = await collectionByName("Team Guides");
    const platform = await collectionByName("Platform Notes");
    expect(team.visibleToRoles).toEqual([]);
    expect(platform.visibleToRoles).toEqual(["infra"]);
    expect(team.createdById).toBe(ADMIN);

    const branches = await docBySlug("branches");
    const flow = await docBySlug("deploy-flow");
    const hosts = await docBySlug("hosts");
    expect(branches).toMatchObject({
      collectionId: team.id,
      parentId: null,
      docType: "runbook",
      createdById: ADMIN,
      content:
        "Merge main first, then read [the flow](/knowledge/deploy-flow) and [the docs](https://example.com/x.md).",
    });
    expect(flow.content).toBe(
      "Deploys go through the panel. Hosts: [map](/knowledge/hosts)."
    );
    expect(hosts).toMatchObject({
      collectionId: platform.id,
      title: "Host Map",
    });
    for (const doc of [branches, flow, hosts]) {
      expect(doc.publishedAt).not.toBeNull();
    }
    // Appended at the end of the collection, in file order.
    const order = await d
      .select({ slug: schema.knowledgeDocuments.slug })
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.collectionId, team.id))
      .orderBy(asc(schema.knowledgeDocuments.rank));
    expect(order.map((r) => r.slug)).toEqual(["branches", "deploy-flow"]);
  });

  it("changes nothing on a second run", async () => {
    const dir = folder("guides", guides);
    const before = await counts();
    const flow = await docBySlug("deploy-flow");
    expect(await run(dir)).toBe(0);
    expect(out).toEqual([
      "unchanged branches.md → branches",
      "unchanged deploy-flow.md → deploy-flow",
      "unchanged host-map.md → hosts",
      "imported: 0 created, 0 updated, 3 unchanged, 0 refused",
    ]);
    expect(await counts()).toEqual(before);
    expect((await docBySlug("deploy-flow")).version).toBe(flow.version);
  });

  it("updates an edited file with a revision", async () => {
    const dir = folder("guides", { ...guides, ...editedFlow });
    const before = await counts();
    const flow = await docBySlug("deploy-flow");
    expect(await run(dir)).toBe(0);
    expect(out).toContain("updated deploy-flow.md → deploy-flow");
    expect(out.at(-1)).toBe(
      "imported: 0 created, 1 updated, 2 unchanged, 0 refused"
    );
    expect(await counts()).toEqual({
      ...before,
      revisions: before.revisions + 1,
      // deploy-flow no longer links to hosts.
      links: before.links - 1,
    });
    const after = await docBySlug("deploy-flow");
    expect(after).toMatchObject({
      id: flow.id,
      content: "Deploys go through the panel, never by hand.",
      docType: "runbook",
      version: flow.version + 1,
      updatedById: ADMIN,
    });
    const [revision] = await d
      .select()
      .from(schema.knowledgeRevisions)
      .where(eq(schema.knowledgeRevisions.documentId, flow.id));
    expect(revision?.content).toBe(flow.content);
  });

  it("stops before any write on a role typo, listing every problem", async () => {
    const dir = folder("typo", {
      "a.md": file(
        "collection: Fresh Notes\ntitle: Alpha\nvisibleTo: [infra, enginer]"
      ),
      "b.md": file("collection: Fresh Notes\ntitle: Beta\nvisibleTo: [qa]"),
      "c.md": file("collection: Fresh Notes"),
      "d.md": file("collection: Team Guides\ntitle: Old Notes"),
      "e.md": file("collection: Fresh Notes\ntitle: Beta"),
      "notes.txt": "not markdown",
    });
    const before = await counts();
    expect(await run(dir)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      'a.md: visibleTo has an unknown role "enginer"',
      "c.md: title is required",
      'b.md, e.md: both resolve to the slug "beta"',
      'd.md: the slug "old-notes" belongs to a document in another collection ("Archive")',
      "nothing imported: 4 problems",
    ]);
    expect(await counts()).toEqual(before);
  });

  it("refuses two files declaring different visibility for one collection", async () => {
    const dir = folder("conflict", {
      "a.md": file("collection: Fresh Notes\ntitle: Alpha\nvisibleTo: [infra]"),
      "b.md": file("collection: Fresh Notes\ntitle: Beta\nvisibleTo: []"),
    });
    const before = await counts();
    expect(await run(dir)).toBe(1);
    expect(err).toEqual([
      'collection "Fresh Notes": the files declare different visibleTo (a.md: infra; b.md: everyone)',
      "nothing imported: 1 problem",
    ]);
    expect(await counts()).toEqual(before);
  });

  it("refuses an existing collection whose visibility differs, unless --update-visibility", async () => {
    const dir = folder("guides", {
      ...guides,
      ...editedFlow,
      "host-map.md": file(
        "collection: Platform Notes\ntitle: Host Map\nslug: hosts\nvisibleTo: [engineer, infra]",
        "sandbox-1.invalid and sandbox-2.invalid run the stack."
      ),
    });
    const before = await counts();
    expect(await run(dir)).toBe(1);
    expect(out).toEqual([
      "unchanged branches.md → branches",
      "unchanged deploy-flow.md → deploy-flow",
      'refused host-map.md → hosts (collection "Platform Notes" is visible to infra, the files say infra, engineer; rerun with --update-visibility to apply it)',
      "imported: 0 created, 0 updated, 2 unchanged, 1 refused",
    ]);
    expect(await counts()).toEqual(before);
    expect((await collectionByName("Platform Notes")).visibleToRoles).toEqual([
      "infra",
    ]);

    expect(await run(dir, { updateVisibility: true, dryRun: true })).toBe(0);
    expect(out[0]).toBe(
      'update collection "Platform Notes" visibility: infra → infra, engineer'
    );
    expect(await counts()).toEqual(before);

    expect(await run(dir, { updateVisibility: true })).toBe(0);
    expect(out).toEqual([
      'update collection "Platform Notes" visibility: infra → infra, engineer',
      "unchanged branches.md → branches",
      "unchanged deploy-flow.md → deploy-flow",
      "updated host-map.md → hosts",
      "imported: 0 created, 1 updated, 2 unchanged, 0 refused",
    ]);
    expect((await collectionByName("Platform Notes")).visibleToRoles).toEqual([
      "infra",
      "engineer",
    ]);
  });

  it("keeps an existing collection's visibility when no file declares one", async () => {
    const dir = folder("undeclared", {
      "extra.md": file("collection: Platform Notes\ntitle: Extra Note"),
    });
    expect(await run(dir)).toBe(0);
    expect(out).toEqual([
      "created extra.md → extra-note",
      "imported: 1 created, 0 updated, 0 unchanged, 0 refused",
    ]);
    expect((await collectionByName("Platform Notes")).visibleToRoles).toEqual([
      "infra",
      "engineer",
    ]);
  });

  it("keeps an explicit slug when the title changes", async () => {
    const hosts = await docBySlug("hosts");
    const dir = folder("guides", {
      ...guides,
      ...editedFlow,
      "host-map.md": file(
        "collection: Platform Notes\ntitle: Host and Network Map\nslug: hosts",
        hosts.content
      ),
    });
    expect(await run(dir)).toBe(0);
    expect(out).toContain("updated host-map.md → hosts");
    expect(await docBySlug("hosts")).toMatchObject({
      id: hosts.id,
      title: "Host and Network Map",
    });
    expect(await run(dir)).toBe(0);
    expect(out).toContain("unchanged host-map.md → hosts");
  });

  it("refuses a folder without markdown files", async () => {
    const dir = folder("empty", { "readme.txt": "no" });
    expect(await run(dir)).toBe(1);
    expect(err).toEqual([`no *.md files in ${dir}`]);
    expect(await run(join(root, "missing"))).toBe(1);
    expect(err[0]).toMatch(/^cannot read the folder /);
  });
});
