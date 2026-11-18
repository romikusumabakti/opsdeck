import { beforeEach, describe, expect, it, vi } from "vitest";

// Staff reads the knowledge base and writes nothing in it, through the real
// lib/authz and server/app. The database must never be reached on a refused
// write: any access throws.

const ID = "0197f3a0-1b2c-7def-8000-0000000000c1";
const ID2 = "0197f3a0-1b2c-7def-8000-0000000000c2";

const state = vi.hoisted(() => ({ role: "staff" }));

vi.mock("@/lib/db", () => {
  const untouchable = new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`db.${String(key)} reached`);
      },
    }
  );
  return { db: untouchable, pgClient: vi.fn() };
});
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: { id: "u1", role: state.role },
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge")>()),
  loadCollections: async () => [],
  loadTreeNodes: async () => [],
}));

const { app } = await import("@/server/app");

const post = (path: string, body: unknown) =>
  app.request(`/api/knowledge/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.role = "staff";
});

describe("staff on the knowledge API", () => {
  it("reads the collections and the tree", async () => {
    expect((await app.request("/api/knowledge/collections")).status).toBe(200);
    expect((await app.request("/api/knowledge/tree")).status).toBe(200);
  });

  it.each([
    ["create-document", { data: { collectionId: ID, title: "Notes" } }],
    ["update-document", { id: ID, data: { title: "Renamed" } }],
    [
      "move-document",
      { data: { documentId: ID, collectionId: ID2, rank: "a0" } },
    ],
    ["delete-document", { id: ID }],
    ["restore-revision", { documentId: ID, revisionId: ID2 }],
    ["create-collection", { data: { name: "Ops" } }],
    ["update-collection", { id: ID, data: { name: "Ops" } }],
    ["delete-collection", { id: ID }],
    ["move-collection", { data: { collectionId: ID, rank: "a0" } }],
  ])("is refused %s (403)", async (path, body) => {
    expect((await post(path, body)).status).toBe(403);
  });

  it("is refused a document's history and an image upload (403)", async () => {
    expect(
      (await app.request("/api/knowledge/documents/some-doc/revisions")).status
    ).toBe(403);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png"));
    const res = await app.request("/api/knowledge/asset", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(403);
  });

  it("a qa passes the same write guard (control)", async () => {
    state.role = "qa";
    // Past the guard the handler reaches the database, which throws here.
    const res = await post("create-document", {
      data: { collectionId: ID, title: "Notes" },
    });
    expect(res.status).not.toBe(403);
  });
});
