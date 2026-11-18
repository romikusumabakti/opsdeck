import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import type { KnowledgeViewer } from "@/lib/knowledge";

// Per-collection knowledge visibility against a real Postgres: every read path
// in lib/knowledge, the asset route and the Assistant tools, for qa vs infra vs
// admin on a collection restricted to infra. Uses the local menara-postgres
// container (postgres 18) through its published port, with the container's
// superuser password read from the container and never printed. It creates a
// scratch database, migrates it with `menara migrate` and drops it
// afterwards; no other database is touched.
//
//   KNOWLEDGE_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/knowledge-visibility-scratch.test.ts
const enabled = process.env.KNOWLEDGE_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "knowledge_visibility_scratch";

const session = vi.hoisted(() => ({
  user: { id: "", role: "qa" },
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: session.user,
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});
vi.mock("@/lib/imgproxy", () => ({
  imgproxyUrl: (key: string) => `http://imgproxy.invalid/${key}`,
}));

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

const ADMIN = "00000000-0000-7000-8000-00000000b001";
const INFRA = "00000000-0000-7000-8000-00000000b002";
const QA = "00000000-0000-7000-8000-00000000b003";
const STAFF = "00000000-0000-7000-8000-00000000b004";

const admin: KnowledgeViewer = {
  userId: ADMIN,
  role: "admin",
  canManage: true,
};
const infra: KnowledgeViewer = {
  userId: INFRA,
  role: "infra",
  canManage: false,
};
const qa: KnowledgeViewer = { userId: QA, role: "qa", canManage: false };
const staff: KnowledgeViewer = {
  userId: STAFF,
  role: "staff",
  canManage: false,
};

describe.skipIf(!enabled)("knowledge collection visibility on Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  const ids = {
    guides: "",
    infraCol: "",
    typoCol: "",
    guide: "",
    hostMap: "",
    qaDraft: "",
    projectDoc: "",
    sharedAsset: "",
    hiddenAsset: "",
    qaUpload: "",
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
    // lib/db reads DATABASE_URL lazily, on the first query.
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    client = postgres(url, { max: 1, onnotice: () => {} });
    const d = drizzle({ client });

    for (const [id, role] of [
      [ADMIN, "admin"],
      [INFRA, "infra"],
      [QA, "qa"],
      [STAFF, "staff"],
    ] as const) {
      await d
        .insert(schema.users)
        .values({ id, name: role, email: `${role}@example.com`, role });
    }
    const project = one(
      await d
        .insert(schema.projects)
        .values({ name: "Pension", key: "pens" })
        .returning()
    );
    await d
      .insert(schema.projectMembers)
      .values({ projectId: project.id, userId: QA });

    const collection = async (name: string, visibleToRoles: string[]) =>
      one(
        await d
          .insert(schema.knowledgeCollections)
          .values({ name, rank: `a${name.length}`, visibleToRoles })
          .returning()
      ).id;
    ids.guides = await collection("Guides", []);
    ids.infraCol = await collection("Infrastructure", ["infra"]);
    ids.typoCol = await collection("Typo", ["nonsense"]);

    const asset = async (uploadedById: string) =>
      one(
        await d
          .insert(schema.knowledgeAttachments)
          .values({
            storageKey: `kb/${uploadedById}.png`,
            mime: "image/png",
            sizeBytes: 3,
            uploadedById,
          })
          .returning()
      ).id;
    ids.sharedAsset = await asset(ADMIN);
    ids.hiddenAsset = await asset(ADMIN);
    ids.qaUpload = await asset(QA);

    const doc = async (
      slug: string,
      collectionId: string,
      content: string,
      opts: {
        published?: boolean;
        createdById?: string;
        projectId?: string;
      } = {}
    ) =>
      one(
        await d
          .insert(schema.knowledgeDocuments)
          .values({
            collectionId,
            title: `Title ${slug}`,
            slug,
            content,
            contentText: content,
            rank: `a${slug.length}`,
            publishedAt: opts.published === false ? null : new Date(),
            createdById: opts.createdById ?? ADMIN,
            projectId: opts.projectId ?? null,
          })
          .returning()
      ).id;
    ids.guide = await doc(
      "deploy-guide",
      ids.guides,
      `common deploy steps, see [map](/knowledge/host-map) ![x](/api/knowledge/asset/${ids.sharedAsset})`
    );
    ids.hostMap = await doc(
      "host-map",
      ids.infraCol,
      `common zebrafish hosts ![y](/api/knowledge/asset/${ids.hiddenAsset}) ![x](/api/knowledge/asset/${ids.sharedAsset}) [guide](/knowledge/deploy-guide)`
    );
    // qa wrote this draft before the collection was restricted.
    ids.qaDraft = await doc("qa-draft", ids.infraCol, "zebrafish draft", {
      published: false,
      createdById: QA,
    });
    ids.projectDoc = await doc(
      "project-runbook",
      ids.infraCol,
      "zebrafish runbook",
      { projectId: project.id }
    );
    await doc("typo-doc", ids.typoCol, "zebrafish typo");

    await d.insert(schema.knowledgeLinks).values([
      { fromDocumentId: ids.guide, toDocumentId: ids.hostMap },
      { fromDocumentId: ids.hostMap, toDocumentId: ids.guide },
    ]);
    await d.insert(schema.knowledgeRevisions).values({
      documentId: ids.hostMap,
      title: "Old host map",
      content: "zebrafish old",
      editedById: ADMIN,
    });
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("lists only the collections the viewer's role can see", async () => {
    const { loadCollections } = await import("@/lib/knowledge");
    const names = async (v: KnowledgeViewer) =>
      (await loadCollections(v)).map((c) => c.name).sort();
    expect(await names(qa)).toEqual(["Guides"]);
    expect(await names(staff)).toEqual(["Guides"]);
    expect(await names(infra)).toEqual(["Guides", "Infrastructure"]);
    expect(await names(admin)).toEqual(["Guides", "Infrastructure", "Typo"]);
  });

  it("keeps hidden collections out of the tree", async () => {
    const { loadTreeNodes } = await import("@/lib/knowledge");
    const slugs = async (v: KnowledgeViewer, collectionId?: string) =>
      (await loadTreeNodes(collectionId, v)).map((n) => n.slug).sort();
    expect(await slugs(qa)).toEqual(["deploy-guide"]);
    expect(await slugs(qa, ids.infraCol)).toEqual([]);
    expect(await slugs(infra)).toEqual([
      "deploy-guide",
      "host-map",
      "project-runbook",
    ]);
    expect(await slugs(admin)).toHaveLength(5);
  });

  it("answers a hidden document like a missing one, by slug and by id", async () => {
    const { loadDocumentBySlug, loadDocumentById } = await import(
      "@/lib/knowledge"
    );
    expect(await loadDocumentBySlug("host-map", qa)).toBeNull();
    expect(await loadDocumentBySlug("host-map", staff)).toBeNull();
    expect((await loadDocumentBySlug("host-map", infra))?.id).toBe(ids.hostMap);
    expect((await loadDocumentBySlug("host-map", admin))?.id).toBe(ids.hostMap);
    expect(await loadDocumentById(ids.hostMap, qa)).toBeNull();
    expect((await loadDocumentById(ids.hostMap, infra))?.slug).toBe("host-map");
    expect(await loadDocumentBySlug("typo-doc", infra)).toBeNull();
    expect(await loadDocumentBySlug("typo-doc", admin)).not.toBeNull();
    // The reader's collection metadata carries no visibility list.
    const doc = await loadDocumentBySlug("host-map", infra);
    expect(Object.keys(doc?.collection ?? {}).sort()).toEqual([
      "icon",
      "id",
      "name",
    ]);
  });

  it("takes a draft away from its author when the collection is restricted", async () => {
    const { loadDocumentBySlug, loadTreeNodes, searchDocuments } = await import(
      "@/lib/knowledge"
    );
    expect(await loadDocumentBySlug("qa-draft", qa)).toBeNull();
    expect(
      (await loadTreeNodes(undefined, qa)).some((n) => n.slug === "qa-draft")
    ).toBe(false);
    expect(
      (await searchDocuments("draft", qa)).some((h) => h.slug === "qa-draft")
    ).toBe(false);
    // infra sees the collection but not someone else's draft.
    expect(await loadDocumentBySlug("qa-draft", infra)).toBeNull();
    expect(await loadDocumentBySlug("qa-draft", admin)).not.toBeNull();
  });

  it("never lets a document's project grant a hidden collection", async () => {
    const { loadDocumentBySlug } = await import("@/lib/knowledge");
    expect(await loadDocumentBySlug("project-runbook", qa)).toBeNull();
    expect(await loadDocumentBySlug("project-runbook", infra)).not.toBeNull();
  });

  it("hides a hidden document's revisions", async () => {
    const { loadRevisions } = await import("@/lib/knowledge");
    expect(await loadRevisions(ids.hostMap, qa)).toEqual([]);
    expect(await loadRevisions(ids.hostMap, infra)).toHaveLength(1);
    expect(await loadRevisions(ids.hostMap, admin)).toHaveLength(1);
  });

  it("search hides restricted collections", async () => {
    const { searchDocuments } = await import("@/lib/knowledge");
    // A word only in the restricted collection: no hit at all.
    expect(await searchDocuments("zebrafish", qa)).toEqual([]);
    expect(await searchDocuments("zebrafish", staff)).toEqual([]);
    // A word in both: exactly the visible hit, no snippet from the hidden one.
    const shared = await searchDocuments("common", qa);
    expect(shared.map((h) => h.slug)).toEqual(["deploy-guide"]);
    expect(shared.map((h) => h.snippet).join(" ")).not.toContain("zebrafish");
    expect(
      (await searchDocuments("zebrafish", infra)).map((h) => h.slug).sort()
    ).toEqual(["host-map", "project-runbook"]);
    expect(await searchDocuments("zebrafish", admin)).toHaveLength(4);
  });

  it("hides the link between a visible and a hidden document both ways", async () => {
    const { loadBacklinks, loadDocumentBySlug } = await import(
      "@/lib/knowledge"
    );
    // The hidden doc links to the visible one: not in its backlinks.
    expect(await loadBacklinks(ids.guide, qa)).toEqual([]);
    expect((await loadBacklinks(ids.guide, infra)).map((b) => b.slug)).toEqual([
      "host-map",
    ]);
    // The hidden doc's own backlinks are not answered at all.
    expect(await loadBacklinks(ids.hostMap, qa)).toEqual([]);
    expect(
      (await loadBacklinks(ids.hostMap, infra)).map((b) => b.slug)
    ).toEqual(["deploy-guide"]);
    // A /knowledge/<slug> link to the hidden doc resolves like a missing
    // slug: the reader opens it through loadDocumentBySlug.
    expect(await loadDocumentBySlug("host-map", qa)).toEqual(
      await loadDocumentBySlug("no-such-doc", qa)
    );
  });

  it("stores a link to a hidden document for readers who can see it", async () => {
    const { createDocument } = await import("@/server/services/knowledge");
    const { loadBacklinks } = await import("@/lib/knowledge");
    session.user = { id: QA, role: "qa" };
    const created = await createDocument({
      collectionId: ids.guides,
      title: "Qa notes",
      content:
        "see [map](/knowledge/host-map) and [g](/knowledge/deploy-guide)",
      publishedAt: new Date().toISOString(),
    });
    if (!created.success) throw new Error(created.message);
    // The writer's response carries nothing about the hidden target.
    expect(JSON.stringify(created.data)).not.toContain(ids.hostMap);
    expect(
      (await loadBacklinks(ids.hostMap, infra)).map((b) => b.slug).sort()
    ).toEqual(["deploy-guide", "qa-notes"]);
    expect((await loadBacklinks(ids.guide, qa)).map((b) => b.slug)).toEqual([
      "qa-notes",
    ]);
  });

  it("serves an asset only through a document the viewer can see", async () => {
    const { loadVisibleAttachment } = await import("@/lib/knowledge");
    expect(await loadVisibleAttachment(ids.hiddenAsset, qa)).toBeNull();
    expect(await loadVisibleAttachment(ids.hiddenAsset, infra)).not.toBeNull();
    expect(await loadVisibleAttachment(ids.hiddenAsset, admin)).not.toBeNull();
    // Also used in a visible document.
    expect(await loadVisibleAttachment(ids.sharedAsset, qa)).not.toBeNull();
    // An uploader keeps their own unreferenced upload; nobody else gets it.
    expect(await loadVisibleAttachment(ids.qaUpload, qa)).not.toBeNull();
    expect(await loadVisibleAttachment(ids.qaUpload, staff)).toBeNull();
    expect(await loadVisibleAttachment(ids.qaUpload, admin)).not.toBeNull();
  });

  it("answers GET /api/knowledge/asset/:id with 404 for a hidden-only image", async () => {
    const { app } = await import("@/server/app");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        })
    );
    try {
      session.user = { id: QA, role: "qa" };
      const hidden = await app.request(
        `/api/knowledge/asset/${ids.hiddenAsset}`
      );
      const missing = await app.request(
        "/api/knowledge/asset/00000000-0000-7000-8000-0000000000ff"
      );
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).toBe(await missing.text());
      expect(
        (await app.request(`/api/knowledge/asset/${ids.sharedAsset}`)).status
      ).toBe(200);
      session.user = { id: INFRA, role: "infra" };
      expect(
        (await app.request(`/api/knowledge/asset/${ids.hiddenAsset}`)).status
      ).toBe(200);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("filters the collection lists and documents served over the API", async () => {
    const { app } = await import("@/server/app");
    session.user = { id: QA, role: "qa" };
    const cols = (await (
      await app.request("/api/knowledge/collections")
    ).json()) as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(["Guides"]);
    expect(
      (await app.request("/api/knowledge/documents/host-map")).status
    ).toBe(404);
    session.user = { id: INFRA, role: "infra" };
    expect(
      (await app.request("/api/knowledge/documents/host-map")).status
    ).toBe(200);
  });

  it("hides restricted documents from the Assistant's knowledge tools", async () => {
    const { loadAssistantViewer } = await import("@/lib/assistant/viewer");
    const { searchKnowledgeTool, readKnowledgeTool } = await import(
      "@/lib/assistant/tools/context"
    );
    const qaViewer = await loadAssistantViewer(QA);
    const infraViewer = await loadAssistantViewer(INFRA);
    const qaHits = await searchKnowledgeTool(qaViewer, "zebrafish");
    const infraHits = await searchKnowledgeTool(infraViewer, "zebrafish");
    if (!qaHits.ok || !infraHits.ok) throw new Error("search failed");
    expect(qaHits.data.hits).toEqual([]);
    expect(infraHits.data.hits.map((h) => h.slug).sort()).toEqual([
      "host-map",
      "project-runbook",
    ]);
    const qaRead = await readKnowledgeTool(qaViewer, "host-map");
    const qaMissing = await readKnowledgeTool(qaViewer, "no-such-doc");
    expect(qaRead.ok).toBe(false);
    if (qaRead.ok || qaMissing.ok) throw new Error("expected failures");
    expect(qaRead.error.replace("host-map", "X")).toBe(
      qaMissing.error.replace("no-such-doc", "X")
    );
    expect((await readKnowledgeTool(infraViewer, "host-map")).ok).toBe(true);
  });
});
