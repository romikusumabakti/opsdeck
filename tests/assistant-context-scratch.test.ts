import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";

// The assistant context tools (viewer, issue scope, knowledge drafts) against a real Postgres: the local
// menara-postgres container (postgres 18) through its published port, with
// the container's superuser password read from the container and never
// printed. It creates a scratch database, migrates it with `menara migrate`
// and drops it afterwards; no other database is touched.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-context-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "assistant_context_scratch";

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

describe.skipIf(!enabled)("assistant context tools on a real Postgres", () => {
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
    // lib/db reads DATABASE_URL lazily, on the first query.
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    client = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("scopes issues and knowledge drafts to the viewer loaded from the DB", async () => {
    const d = drizzle({ client });
    const { loadAssistantViewer } = await import("@/lib/assistant/viewer");
    const {
      getIssueTool,
      visibleIssueByKey,
      searchKnowledgeTool,
      readKnowledgeTool,
    } = await import("@/lib/assistant/tools/context");

    const user = async (id: string, role: string, banned = false) =>
      one(
        await d
          .insert(schema.users)
          .values({
            id,
            name: id,
            email: `${role}-${id.slice(-4)}@example.com`,
            role,
            banned,
          })
          .returning()
      );
    const qa = await user("00000000-0000-7000-8000-00000000a001", "qa");
    const admin = await user("00000000-0000-7000-8000-00000000a002", "admin");
    const banned = await user(
      "00000000-0000-7000-8000-00000000a003",
      "qa",
      true
    );

    const project = async (key: string) =>
      one(
        await d.insert(schema.projects).values({ name: key, key }).returning()
      );
    const kmem = await project("kmem");
    const hmem = await project("hmem");
    await d
      .insert(schema.projectMembers)
      .values({ projectId: kmem.id, userId: qa.id });

    const issue = async (projectId: string, jiraKey: string, title: string) =>
      one(
        await d
          .insert(schema.issues)
          .values({
            projectId,
            number: 1,
            title,
            jiraKey,
            jiraIssueId: jiraKey,
          })
          .returning()
      );
    const own = await issue(kmem.id, "KST-1", "Visible issue");
    await issue(hmem.id, "CRM-1", "Other client issue");
    await d
      .insert(schema.issueComments)
      .values({ issueId: own.id, authorId: admin.id, body: "hello" });

    const qaViewer = await loadAssistantViewer(qa.id);
    const adminViewer = await loadAssistantViewer(admin.id);
    expect(qaViewer.projectIds).toEqual([kmem.id]);
    expect(adminViewer.projectIds).toBe("all");
    await expect(loadAssistantViewer(banned.id)).rejects.toThrow(/banned/);

    expect(await visibleIssueByKey(qaViewer, "CRM-1")).toBeNull();
    expect((await visibleIssueByKey(adminViewer, "CRM-1"))?.issue.title).toBe(
      "Other client issue"
    );
    const got = await getIssueTool(qaViewer, "KST-1");
    if (!got.ok) throw new Error(got.error);
    expect(got.data.comments).toEqual([
      expect.objectContaining({ author: admin.name, body: "hello" }),
    ]);
    expect(got.data.attachmentsError).toMatch(/no Jira link/);

    const collection = one(
      await d
        .insert(schema.knowledgeCollections)
        .values({ name: "KB", rank: "a0" })
        .returning()
    );
    const doc = (slug: string, published: boolean) =>
      d.insert(schema.knowledgeDocuments).values({
        collectionId: collection.id,
        title: `Iuran ${slug}`,
        slug,
        content: `# Iuran ${slug}`,
        contentText: `Iuran ${slug}`,
        rank: slug === "draft" ? "a1" : "a2",
        publishedAt: published ? new Date() : null,
        createdById: admin.id,
      });
    await doc("draft", false);
    await doc("published", true);

    const qaHits = await searchKnowledgeTool(qaViewer, "iuran");
    const adminHits = await searchKnowledgeTool(adminViewer, "iuran");
    if (!qaHits.ok || !adminHits.ok) throw new Error("search failed");
    expect(qaHits.data.hits.map((h) => h.slug)).toEqual(["published"]);
    expect(adminHits.data.hits.map((h) => h.slug).sort()).toEqual([
      "draft",
      "published",
    ]);
    expect((await readKnowledgeTool(qaViewer, "draft")).ok).toBe(false);
    expect((await readKnowledgeTool(adminViewer, "draft")).ok).toBe(true);
  });
});
