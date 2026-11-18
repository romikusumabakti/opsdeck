import { execFileSync, spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import type { KnowledgeActor } from "@/server/services/knowledge";

// The knowledge write cores against a real Postgres, for actors on both sides
// of a collection restricted to infra: a hidden collection, document, parent
// or revision answers exactly like a missing one (404), a slug that collides
// with a hidden document is suffixed, and collection visibility is validated.
// Same setup as knowledge-visibility-scratch.test.ts: the local
// menara-postgres container, a scratch database migrated with
// `menara migrate` and dropped afterwards; no other database is touched.
//
//   KNOWLEDGE_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/knowledge-writes-scratch.test.ts
const enabled = process.env.KNOWLEDGE_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "knowledge_writes_scratch";

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

const ADMIN = "00000000-0000-7000-8000-00000000c001";
const INFRA = "00000000-0000-7000-8000-00000000c002";
const QA = "00000000-0000-7000-8000-00000000c003";
const STAFF = "00000000-0000-7000-8000-00000000c004";
const MISSING = "00000000-0000-7000-8000-0000000000ff";

const admin: KnowledgeActor = { userId: ADMIN, role: "admin" };
const infra: KnowledgeActor = { userId: INFRA, role: "infra" };
const qa: KnowledgeActor = { userId: QA, role: "qa" };
const staff: KnowledgeActor = { userId: STAFF, role: "staff" };

// What a refused call answers: the HTTP status and message it throws.
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof HTTPException) {
      return {
        status: error.status,
        message: error.message,
        code: (error as { code?: string }).code,
      };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

const NOT_FOUND = { status: 404, message: "Not Found", code: undefined };

describe.skipIf(!enabled)("knowledge write cores on Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let d: ReturnType<typeof drizzle>;
  let previousUrl: string | undefined;
  const ids = {
    guides: "",
    infraCol: "",
    guide: "",
    hostMap: "",
    hostRevision: "",
    infraDraft: "",
  };

  const docRow = async (id: string) =>
    one(
      await d
        .select()
        .from(schema.knowledgeDocuments)
        .where(eq(schema.knowledgeDocuments.id, id))
    );
  const revisionCount = async (documentId: string) =>
    (
      await d
        .select()
        .from(schema.knowledgeRevisions)
        .where(eq(schema.knowledgeRevisions.documentId, documentId))
    ).length;

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
    d = drizzle({ client });

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
    const collection = async (name: string, visibleToRoles: string[]) =>
      one(
        await d
          .insert(schema.knowledgeCollections)
          .values({ name, rank: `a${name.length}`, visibleToRoles })
          .returning()
      ).id;
    ids.guides = await collection("Guides", []);
    ids.infraCol = await collection("Infrastructure", ["infra"]);

    const doc = async (
      slug: string,
      collectionId: string,
      opts: { published?: boolean; createdById?: string } = {}
    ) =>
      one(
        await d
          .insert(schema.knowledgeDocuments)
          .values({
            collectionId,
            title: `Title ${slug}`,
            slug,
            content: `body of ${slug}`,
            contentText: `body of ${slug}`,
            rank: `a${slug.length}`,
            publishedAt: opts.published === false ? null : new Date(),
            createdById: opts.createdById ?? ADMIN,
          })
          .returning()
      ).id;
    ids.guide = await doc("deploy-guide", ids.guides);
    ids.hostMap = await doc("host-map", ids.infraCol);
    ids.infraDraft = await doc("infra-draft", ids.guides, {
      published: false,
      createdById: INFRA,
    });
    ids.hostRevision = one(
      await d
        .insert(schema.knowledgeRevisions)
        .values({
          documentId: ids.hostMap,
          title: "Old host map",
          content: "old body",
          editedById: ADMIN,
        })
        .returning()
    ).id;
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("refuses to create a document in a hidden collection like a missing one", async () => {
    const { createDocumentFor } = await import("@/server/services/knowledge");
    const input = (collectionId: string) => ({
      collectionId,
      title: "Sneaky",
      content: "x",
    });
    expect(await refusal(createDocumentFor(qa, input(ids.infraCol)))).toEqual(
      NOT_FOUND
    );
    expect(await refusal(createDocumentFor(qa, input(MISSING)))).toEqual(
      NOT_FOUND
    );
    // Under a hidden parent, from a visible collection: the same.
    expect(
      await refusal(
        createDocumentFor(qa, {
          ...input(ids.guides),
          parentId: ids.hostMap,
        })
      )
    ).toEqual(NOT_FOUND);
    const sneaky = await d
      .select()
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.title, "Sneaky"));
    expect(sneaky).toEqual([]);
    // infra sees the collection.
    const created = await createDocumentFor(infra, input(ids.infraCol));
    expect(created.success).toBe(true);
  });

  it("suffixes a slug that collides with a hidden document instead of refusing", async () => {
    const { createDocumentFor, updateDocumentFor } = await import(
      "@/server/services/knowledge"
    );
    const created = await createDocumentFor(qa, {
      collectionId: ids.guides,
      title: "Host map",
      content: "my own map",
    });
    if (!created.success) throw new Error(created.message);
    expect(created.data.slug).toBe("host-map-2");
    expect(JSON.stringify(created)).not.toContain(ids.hostMap);
    // A rename into the hidden slug: suffixed too.
    const renamed = await updateDocumentFor(qa, ids.guide, {
      title: "Host map",
    });
    if (!renamed.success) throw new Error(renamed.message);
    expect(renamed.data.slug).toBe("host-map-3");
    await updateDocumentFor(qa, ids.guide, { title: "Deploy guide" });
  });

  it("links a new document from documents that already pointed at its slug", async () => {
    const { createDocumentFor } = await import("@/server/services/knowledge");
    const linker = await createDocumentFor(qa, {
      collectionId: ids.guides,
      title: "Linker",
      content:
        "See [later](/knowledge/later-page), not [longer](/knowledge/later-page-2) or `[code](/knowledge/later-page)`.",
    });
    if (!linker.success) throw new Error(linker.message);
    const target = await createDocumentFor(qa, {
      collectionId: ids.guides,
      title: "Later page",
    });
    if (!target.success) throw new Error(target.message);
    expect(target.data.slug).toBe("later-page");
    const edges = await d
      .select()
      .from(schema.knowledgeLinks)
      .where(eq(schema.knowledgeLinks.toDocumentId, target.data.id));
    expect(edges.map((e) => e.fromDocumentId)).toEqual([linker.data.id]);
  });

  it("answers an update of a hidden document like a missing one and writes nothing", async () => {
    const { updateDocumentFor } = await import("@/server/services/knowledge");
    const before = await docRow(ids.hostMap);
    const revisions = await revisionCount(ids.hostMap);
    expect(
      await refusal(updateDocumentFor(qa, ids.hostMap, { content: "pwned" }))
    ).toEqual(NOT_FOUND);
    expect(
      await refusal(updateDocumentFor(qa, MISSING, { content: "pwned" }))
    ).toEqual(NOT_FOUND);
    expect(
      await refusal(updateDocumentFor(staff, ids.hostMap, { content: "x" }))
    ).toMatchObject({ status: 403 });
    expect(await docRow(ids.hostMap)).toEqual(before);
    expect(await revisionCount(ids.hostMap)).toBe(revisions);
    // Someone else's draft in a visible collection: hidden too.
    expect(
      await refusal(updateDocumentFor(qa, ids.infraDraft, { content: "x" }))
    ).toEqual(NOT_FOUND);
    const ok = await updateDocumentFor(infra, ids.hostMap, {
      content: "new map",
    });
    expect(ok.success).toBe(true);
  });

  it("refuses an update that moves a document into a hidden collection or under a hidden parent", async () => {
    const { updateDocumentFor } = await import("@/server/services/knowledge");
    const before = await docRow(ids.guide);
    expect(
      await refusal(
        updateDocumentFor(qa, ids.guide, { collectionId: ids.infraCol })
      )
    ).toEqual(NOT_FOUND);
    expect(
      await refusal(updateDocumentFor(qa, ids.guide, { parentId: ids.hostMap }))
    ).toEqual(NOT_FOUND);
    expect(await docRow(ids.guide)).toEqual(before);
  });

  it("answers moves of, into or under hidden rows like missing ones", async () => {
    const { moveDocumentFor } = await import("@/server/services/knowledge");
    const guideBefore = await docRow(ids.guide);
    const hostBefore = await docRow(ids.hostMap);
    const move = (
      documentId: string,
      collectionId: string,
      parentId: string | null = null
    ) =>
      moveDocumentFor(qa, { documentId, collectionId, parentId, rank: "a0" });
    expect(await refusal(move(ids.hostMap, ids.guides))).toEqual(NOT_FOUND);
    expect(await refusal(move(MISSING, ids.guides))).toEqual(NOT_FOUND);
    expect(await refusal(move(ids.guide, ids.infraCol))).toEqual(NOT_FOUND);
    expect(await refusal(move(ids.guide, MISSING))).toEqual(NOT_FOUND);
    expect(await refusal(move(ids.guide, ids.guides, ids.hostMap))).toEqual(
      NOT_FOUND
    );
    expect(await docRow(ids.guide)).toEqual(guideBefore);
    expect(await docRow(ids.hostMap)).toEqual(hostBefore);
    // Within what qa sees, a move still works.
    expect((await move(ids.guide, ids.guides)).success).toBe(true);
  });

  it("answers a restore on a hidden document like a missing revision", async () => {
    const { restoreRevisionFor } = await import("@/server/services/knowledge");
    const before = await docRow(ids.hostMap);
    expect(
      await refusal(restoreRevisionFor(qa, ids.hostMap, ids.hostRevision))
    ).toEqual(NOT_FOUND);
    expect(await refusal(restoreRevisionFor(qa, ids.hostMap, MISSING))).toEqual(
      NOT_FOUND
    );
    expect(await docRow(ids.hostMap)).toEqual(before);
    const restored = await restoreRevisionFor(
      infra,
      ids.hostMap,
      ids.hostRevision
    );
    if (!restored.success) throw new Error(restored.message);
    expect(restored.data.title).toBe("Old host map");
  });

  it("deletes documents for managers only", async () => {
    const { createDocumentFor, deleteDocumentFor } = await import(
      "@/server/services/knowledge"
    );
    const created = await createDocumentFor(infra, {
      collectionId: ids.infraCol,
      title: "Throwaway",
    });
    if (!created.success) throw new Error(created.message);
    expect(
      await refusal(deleteDocumentFor(infra, created.data.id))
    ).toMatchObject({ status: 403 });
    expect((await deleteDocumentFor(admin, created.data.id)).success).toBe(
      true
    );
  });

  it("creates and updates a collection's visibility for managers only", async () => {
    const { createCollectionFor, updateCollectionFor } = await import(
      "@/server/services/knowledge"
    );
    expect(
      await refusal(createCollectionFor(infra, { name: "Mine" }))
    ).toMatchObject({ status: 403 });
    const open = await createCollectionFor(admin, { name: "Open" });
    if (!open.success) throw new Error(open.message);
    expect(open.data.visibleToRoles).toEqual([]);
    // Deduplicated and stored in the global role order.
    const restricted = await createCollectionFor(admin, {
      name: "Restricted",
      visibleToRoles: ["qa", "infra", "qa"],
    });
    if (!restricted.success) throw new Error(restricted.message);
    expect(restricted.data.visibleToRoles).toEqual(["infra", "qa"]);
    // A rename leaves the list alone; an empty list opens it to everyone.
    const renamed = await updateCollectionFor(admin, restricted.data.id, {
      name: "Renamed",
    });
    if (!renamed.success) throw new Error(renamed.message);
    expect(renamed.data.visibleToRoles).toEqual(["infra", "qa"]);
    const opened = await updateCollectionFor(admin, restricted.data.id, {
      visibleToRoles: [],
    });
    if (!opened.success) throw new Error(opened.message);
    expect(opened.data.visibleToRoles).toEqual([]);
    expect(
      await refusal(
        updateCollectionFor(infra, restricted.data.id, { visibleToRoles: [] })
      )
    ).toMatchObject({ status: 403 });
  });

  it("refuses admin and unknown roles in a collection's visibility with a stable code", async () => {
    const { createCollectionFor, updateCollectionFor } = await import(
      "@/server/services/knowledge"
    );
    for (const visibleToRoles of [["admin"], ["infra", "nonsense"]]) {
      expect(
        await refusal(
          createCollectionFor(admin, { name: "Bad", visibleToRoles })
        )
      ).toMatchObject({ status: 400, code: "knowledgeVisibilityInvalid" });
      expect(
        await refusal(
          updateCollectionFor(admin, ids.guides, { visibleToRoles })
        )
      ).toMatchObject({ status: 400, code: "knowledgeVisibilityInvalid" });
    }
    const bad = await d
      .select()
      .from(schema.knowledgeCollections)
      .where(eq(schema.knowledgeCollections.name, "Bad"));
    expect(bad).toEqual([]);
    expect(
      one(
        await d
          .select()
          .from(schema.knowledgeCollections)
          .where(eq(schema.knowledgeCollections.id, ids.guides))
      ).visibleToRoles
    ).toEqual([]);
  });

  it("answers the same over the API for a hidden and a missing document", async () => {
    const { app } = await import("@/server/app");
    session.user = { id: QA, role: "qa" };
    const post = (path: string, body: unknown) =>
      app.request(`/api/knowledge/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const hidden = await post("update-document", {
      id: ids.hostMap,
      data: { content: "x" },
    });
    const missing = await post("update-document", {
      id: MISSING,
      data: { content: "x" },
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe(await missing.text());
    session.user = { id: ADMIN, role: "admin" };
    const bad = await post("create-collection", {
      data: { name: "Bad", visibleToRoles: ["admin"] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code?: string }).code).toBe(
      "knowledgeVisibilityInvalid"
    );
  });

  it("serves an asset requested by an uppercase id to a viewer who may see it", async () => {
    const { loadVisibleAttachment } = await import("@/lib/knowledge");
    const asset = one(
      await d
        .insert(schema.knowledgeAttachments)
        .values({
          storageKey: "kb/upper.png",
          mime: "image/png",
          sizeBytes: 3,
          uploadedById: ADMIN,
        })
        .returning()
    ).id;
    await d
      .update(schema.knowledgeDocuments)
      .set({ content: `![x](/api/knowledge/asset/${asset})` })
      .where(eq(schema.knowledgeDocuments.id, ids.guide));
    const viewer = { userId: QA, role: "qa", canManage: false } as const;
    expect(await loadVisibleAttachment(asset.toUpperCase(), viewer)).toEqual({
      storageKey: "kb/upper.png",
      mime: "image/png",
    });
  });
});
