import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  docxBytes,
  pdfBytes,
  pngBytes,
  withClaimedSizes,
  zipBytes,
} from "./support/upload-fixtures";

// Files uploaded for a question, end to end through the Hono app over an
// in-memory file store and object storage: the upload's checks (type by its
// bytes, size by its type, unsent files per user), owner-only removal, the
// send that attaches them, the hourly prune, and read_upload per provider.
// The SQL itself (attach, removal, prune, a chat's files) runs against
// Postgres in assistant-files-scratch.test.ts.

const QA = "0197f3a0-1b2c-7def-8000-00000000f001";
const OTHER = "0197f3a0-1b2c-7def-8000-00000000f002";
const CONV = "0197f3a0-1b2c-7def-8000-00000000c001";
const OTHER_CONV = "0197f3a0-1b2c-7def-8000-00000000c002";

type FileRow = {
  id: string;
  userId: string;
  storageKey: string;
  filename: string;
  mediaType: string;
  size: number;
  messageId: string | null;
  conversationId: string | null;
  createdAt: Date;
};

const state = vi.hoisted(() => ({
  userId: "",
  limits: { enabled: true, hasApiKey: true, dailyCapUsd: 5, readsImages: true },
  files: [] as FileRow[],
  objects: new Map<string, { bytes: Buffer; contentType: string }>(),
  messages: [] as { id: string; conversationId: string; role: string }[],
  seq: 0,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: state.userId, role: "qa" },
  })),
}));
vi.mock("@/lib/authz", async () => {
  const { HTTPException } = await import("hono/http-exception");
  class ForbiddenError extends HTTPException {
    constructor() {
      super(403, { message: "Forbidden" });
    }
  }
  return {
    ForbiddenError,
    accessibleProjectIds: vi.fn(async () => ["p1"]),
    getProjectAccess: vi.fn(async () => ({ all: false, roles: { p1: "qa" } })),
    requireProjectPermission: vi.fn(),
  };
});
vi.mock("@/lib/assistant/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/client")>()),
  loadAssistantRuntime: vi.fn(async () => ({ dailyCapUsd: 5 })),
}));
vi.mock("@/lib/assistant/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/usage")>()),
  spentTodayUsd: vi.fn(async () => 0),
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}) }));
vi.mock("@/lib/assistant/queue", () => ({
  enqueueAssistantTurn: queue.enqueue,
}));

vi.mock("@/lib/assistant/conversation-store", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/assistant/conversation-store")>();
  const owners: Record<string, string> = {
    "0197f3a0-1b2c-7def-8000-00000000c001":
      "0197f3a0-1b2c-7def-8000-00000000f001",
    "0197f3a0-1b2c-7def-8000-00000000c002":
      "0197f3a0-1b2c-7def-8000-00000000f002",
  };
  const nextId = () =>
    `0197f3a0-1b2c-7def-8000-${String(++state.seq).padStart(12, "0")}`;
  return {
    ...real,
    loadAssistantLimits: async () => state.limits,
    findConversation: async (id: string) =>
      owners[id] ? { id, userId: owners[id] } : null,
    // Like the transaction: every file must be the owner's unsent upload,
    // else nothing is written.
    insertTurn: async (p: { conversationId: string; fileIds?: string[] }) => {
      const owner = owners[p.conversationId];
      const ids = p.fileIds ?? [];
      const mine = state.files.filter(
        (f) => ids.includes(f.id) && f.userId === owner && !f.messageId
      );
      if (mine.length !== new Set(ids).size) return "files_gone";
      const question = { id: nextId(), conversationId: p.conversationId };
      const answer = { id: nextId(), conversationId: p.conversationId };
      state.messages.push(
        { ...question, role: "user" },
        { ...answer, role: "assistant" }
      );
      for (const f of mine) {
        f.messageId = question.id;
        f.conversationId = p.conversationId;
      }
      return { userMessageId: question.id, assistantMessageId: answer.id };
    },
  };
});

vi.mock("@/lib/assistant/file-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/file-store")>()),
  insertUpload: vi.fn(
    async (v: Omit<FileRow, "messageId" | "conversationId" | "createdAt">) => {
      state.files.push({
        ...v,
        messageId: null,
        conversationId: null,
        createdAt: new Date(),
      });
    }
  ),
  countUnsentUploads: vi.fn(
    async (userId: string) =>
      state.files.filter((f) => f.userId === userId && !f.messageId).length
  ),
  deleteUnsentUpload: vi.fn(async (userId: string, id: string) => {
    const f = state.files.find(
      (x) => x.id === id && x.userId === userId && !x.messageId
    );
    if (!f) return null;
    state.files = state.files.filter((x) => x !== f);
    return f.storageKey;
  }),
  deleteStaleUnsentUploads: vi.fn(async () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale = state.files.filter(
      (f) => !f.messageId && f.createdAt.getTime() < cutoff
    );
    state.files = state.files.filter((f) => !stale.includes(f));
    return stale.map((f) => f.storageKey);
  }),
}));

vi.mock("@/lib/assistant/file-text", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/assistant/file-text")>();
  return { ...real, extractUploadText: vi.fn(real.extractUploadText) };
});

const storage = vi.hoisted(() => ({
  putObject: vi.fn(async (key: string, bytes: Buffer, contentType: string) => {
    state.objects.set(key, { bytes, contentType });
  }),
  deleteObject: vi.fn(async (key: string) => {
    state.objects.delete(key);
  }),
  getObjectBytes: vi.fn(async (key: string, max: number) => {
    const object = state.objects.get(key);
    if (!object) throw new Error("NoSuchKey");
    if (object.bytes.byteLength > max) throw new Error("too large");
    return new Uint8Array(object.bytes);
  }),
}));
vi.mock("@/lib/storage", () => storage);

const { app } = await import("@/server/app");
const { pruneUnsentUploads } = await import("@/lib/assistant/upload-prune");
const { executeTool, toolModelOutput } = await import(
  "@/lib/assistant/tool-defs"
);
const { buildHistory } = await import("@/lib/assistant/run-turn");
const { MODEL_NO_IMAGES } = await import("@/lib/assistant/tools/uploads");
const fileText = await import("@/lib/assistant/file-text");

const BASE = "/api/assistant";
const MiB = 1024 * 1024;

function upload(bytes: Uint8Array, name: string) {
  const body = new FormData();
  body.set("file", new File([new Uint8Array(bytes)], name));
  return app.request(`${BASE}/upload`, {
    method: "POST",
    headers: { "Sec-Fetch-Site": "same-origin" },
    body,
  });
}

function remove(id: string) {
  return app.request(`${BASE}/upload/${id}`, {
    method: "DELETE",
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
}

function send(conversationId: string, fileIds: string[]) {
  return app.request(`${BASE}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId,
      text: "What is in these files?",
      context: { kind: "auto" },
      fileIds,
    }),
  });
}

async function uploaded(name = "shot.png", bytes: Uint8Array = pngBytes()) {
  const res = await upload(bytes, name);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    filename: string;
    mediaType: string;
    size: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.userId = QA;
  state.limits = {
    enabled: true,
    hasApiKey: true,
    dailyCapUsd: 5,
    readsImages: true,
  };
  state.files = [];
  state.objects = new Map();
  state.messages = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /upload", () => {
  it("stores an image under the uploader's prefix, unsent", async () => {
    const file = await uploaded("Screen shot.png");
    expect(file).toEqual({
      id: expect.any(String),
      filename: "Screen shot.png",
      mediaType: "image/png",
      size: 64,
    });
    expect(storage.putObject).toHaveBeenCalledWith(
      `assistant/${QA}/${file.id}`,
      expect.any(Buffer),
      "image/png"
    );
    expect(state.files).toEqual([
      expect.objectContaining({
        id: file.id,
        userId: QA,
        storageKey: `assistant/${QA}/${file.id}`,
        messageId: null,
      }),
    ]);
  });

  it("refuses a ZIP named .png, storing nothing", async () => {
    const res = await upload(await zipBytes(), "shot.png");
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({
      code: "assistant.file_type_unsupported",
    });
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(state.files).toEqual([]);
  });

  it("refuses a 6 MB PNG with the image limit, storing nothing", async () => {
    const res = await upload(pngBytes(6 * MiB), "big.png");
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: "assistant.file_too_large",
      params: { limitMb: 5 },
    });
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(state.files).toEqual([]);
  });

  it("takes a 6 MB PDF (its limit is 15 MB) and a Word document", async () => {
    const pdf = new Uint8Array(6 * MiB);
    pdf.set(pdfBytes("Acme"));
    expect((await uploaded("report.pdf", pdf)).mediaType).toBe(
      "application/pdf"
    );
    expect((await uploaded("brief.docx", await docxBytes(["Hi"]))).size).toBe(
      (await docxBytes(["Hi"])).byteLength
    );
  });

  it("refuses a body over the largest limit before parsing it", async () => {
    const res = await upload(new Uint8Array(21 * MiB), "huge.txt");
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: "assistant.file_too_large",
      params: { limitMb: 20 },
    });
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("refuses a request without a file, and an empty file", async () => {
    const res = await app.request(`${BASE}/upload`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    expect((await upload(new Uint8Array(0), "a.txt")).status).toBe(415);
    expect(state.files).toEqual([]);
  });

  it("refuses more unsent files than a few questions' worth", async () => {
    const text = new TextEncoder().encode("x");
    for (let i = 0; i < 30; i++) await uploaded(`n${i}.txt`, text);
    const res = await upload(text, "one-more.txt");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "assistant.too_many_files",
      params: { max: 10 },
    });
    // Refused before the body is read: the file is never buffered.
    const { uploadFile } = await import("@/server/services/assistant-files");
    const readFile = vi.fn(async () => new File([text], "late.txt"));
    await expect(uploadFile(readFile)).rejects.toMatchObject({ status: 409 });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("is behind the assistant's gate, checked before the body limit", async () => {
    state.limits.enabled = false;
    const res = await upload(pngBytes(), "shot.png");
    expect(res.status).toBe(503);
    // An oversized body gets the gate's answer, not the body limit's.
    const huge = await upload(new Uint8Array(21 * MiB), "huge.txt");
    expect(huge.status).toBe(503);
    expect(state.files).toEqual([]);
  });

  it("refuses a Word document that would inflate past the bounds", async () => {
    const bomb = withClaimedSizes(await docxBytes(["Hi"]), 60 * MiB);
    const res = await upload(bomb, "brief.docx");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "assistant.file_too_complex",
    });
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(state.files).toEqual([]);
  });
});

describe("DELETE /upload/:id", () => {
  it("removes the owner's unsent upload and its object", async () => {
    const file = await uploaded();
    const res = await remove(file.id);
    expect(res.status).toBe(200);
    expect(state.files).toEqual([]);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      `assistant/${QA}/${file.id}`
    );
  });

  it("is a 404 for another user's upload and for one already sent", async () => {
    const file = await uploaded();
    state.userId = OTHER;
    expect((await remove(file.id)).status).toBe(404);
    state.userId = QA;
    expect((await send(CONV, [file.id])).status).toBe(200);
    expect((await remove(file.id)).status).toBe(404);
    expect((await remove("not-a-uuid")).status).toBe(404);
    expect(state.files).toHaveLength(1);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe("send-message with files", () => {
  it("attaches the caller's unsent uploads to the question", async () => {
    const a = await uploaded("a.png");
    const b = await uploaded("b.txt", new TextEncoder().encode("notes"));
    const res = await send(CONV, [a.id, b.id, a.id]);
    expect(res.status).toBe(200);
    const { userMessageId } = (await res.json()) as { userMessageId: string };
    expect(state.files.map((f) => f.messageId)).toEqual([
      userMessageId,
      userMessageId,
    ]);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses an 11th file, writing nothing", async () => {
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push((await uploaded(`f${i}.png`)).id);
    const res = await send(CONV, ids);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "assistant.too_many_files",
      params: { max: 10 },
    });
    expect(state.messages).toEqual([]);
    expect(state.files.every((f) => f.messageId === null)).toBe(true);
  });

  it("is a 404 for another user's file id, writing nothing", async () => {
    state.userId = OTHER;
    const theirs = await uploaded();
    state.userId = QA;
    const mine = await uploaded();
    const res = await send(CONV, [mine.id, theirs.id]);
    expect(res.status).toBe(404);
    expect(state.messages).toEqual([]);
    expect(state.files.every((f) => f.messageId === null)).toBe(true);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("is a 404 for a file another question already carries", async () => {
    const file = await uploaded();
    expect((await send(CONV, [file.id])).status).toBe(200);
    expect((await send(CONV, [file.id])).status).toBe(404);
  });

  it("a file id never reaches another user's chat", async () => {
    const file = await uploaded();
    expect((await send(OTHER_CONV, [file.id])).status).toBe(404);
    expect(state.files[0]?.messageId).toBeNull();
  });
});

describe("pruneUnsentUploads", () => {
  it("deletes unsent uploads older than 24 h, row and object", async () => {
    const old = await uploaded("old.png");
    const fresh = await uploaded("fresh.png");
    const sent = await uploaded("sent.png");
    expect((await send(CONV, [sent.id])).status).toBe(200);
    for (const f of state.files) {
      if (f.id !== fresh.id) f.createdAt = new Date(Date.now() - 25 * 3600e3);
    }
    expect(await pruneUnsentUploads()).toBe(1);
    expect(state.files.map((f) => f.id).sort()).toEqual(
      [fresh.id, sent.id].sort()
    );
    expect(state.objects.has(`assistant/${QA}/${old.id}`)).toBe(false);
    expect(state.objects.has(`assistant/${QA}/${fresh.id}`)).toBe(true);
  });

  it("logs an object that cannot be removed and still counts the row", async () => {
    const file = await uploaded();
    const row = state.files[0];
    if (row) row.createdAt = new Date(0);
    storage.deleteObject.mockRejectedValueOnce(new Error("storage down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await pruneUnsentUploads()).toBe(1);
    expect(errors).toHaveBeenCalledWith(
      `[assistant] could not delete stored upload assistant/${QA}/${file.id}:`,
      expect.any(Error)
    );
    errors.mockRestore();
  });
});

// --- read_upload ------------------------------------------------------------

function uploadRef(
  id: string,
  filename: string,
  mediaType: string,
  bytes: Uint8Array
) {
  const storageKey = `assistant/${QA}/${id}`;
  state.objects.set(storageKey, {
    bytes: Buffer.from(bytes),
    contentType: mediaType,
  });
  return { id, filename, mediaType, size: bytes.byteLength, storageKey };
}

function toolContext(
  uploads: ReturnType<typeof uploadRef>[],
  nativeFiles: boolean
) {
  return {
    mode: "pinned" as const,
    snaps: [],
    viewer: {} as never,
    panel: {} as never,
    attachments: [],
    uploads,
    nativeFiles,
  };
}

const IMG = "0197f3a0-1b2c-7def-8000-0000000a0001";
const PDF = "0197f3a0-1b2c-7def-8000-0000000a0002";
const DOC = "0197f3a0-1b2c-7def-8000-0000000a0003";

describe("read_upload", () => {
  it("refuses a file that is not on this chat's questions, reading nothing", async () => {
    // Another chat's upload exists in storage, but this turn's list lacks it.
    uploadRef(IMG, "theirs.png", "image/png", pngBytes());
    const result = await executeTool(
      "read_upload",
      { file_id: IMG },
      toolContext([], true)
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(
      "not uploaded in this chat"
    );
    expect(storage.getObjectBytes).not.toHaveBeenCalled();
  });

  it("gives a native model images and PDFs as file parts", async () => {
    const ctx = toolContext(
      [
        uploadRef(IMG, "shot.png", "image/png", pngBytes()),
        uploadRef(PDF, "report.pdf", "application/pdf", pdfBytes("Acme")),
      ],
      true
    );
    const image = await executeTool("read_upload", { file_id: IMG }, ctx);
    expect(image.meta).toEqual({ fileIds: [IMG] });
    expect(toolModelOutput("read_upload", image)).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          data: {
            type: "data",
            data: Buffer.from(pngBytes()).toString("base64"),
          },
          mediaType: "image/png",
        },
      ],
    });
    const pdf = await executeTool("read_upload", { file_id: PDF }, ctx);
    const output = toolModelOutput("read_upload", pdf);
    expect(output).toMatchObject({
      type: "content",
      value: [{ type: "file", mediaType: "application/pdf" }],
    });
  });

  it("gives an OpenAI-compatible model a PDF's text and says it cannot see images", async () => {
    const ctx = toolContext(
      [
        uploadRef(IMG, "shot.png", "image/png", pngBytes()),
        uploadRef(
          PDF,
          "report.pdf",
          "application/pdf",
          pdfBytes("Acme invoice 42")
        ),
      ],
      false
    );
    const pdf = toolModelOutput(
      "read_upload",
      await executeTool("read_upload", { file_id: PDF }, ctx)
    );
    expect(pdf).toEqual({
      type: "content",
      value: [
        { type: "text", text: expect.stringContaining("Acme invoice 42") },
      ],
    });
    storage.getObjectBytes.mockClear();
    const image = toolModelOutput(
      "read_upload",
      await executeTool("read_upload", { file_id: IMG }, ctx)
    );
    expect(image).toEqual({
      type: "content",
      value: [{ type: "text", text: MODEL_NO_IMAGES }],
    });
    expect(storage.getObjectBytes).not.toHaveBeenCalled();
  });

  it("reads a Word document as text, redacting credential lines", async () => {
    const ctx = toolContext(
      [
        uploadRef(
          DOC,
          "setup.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          await docxBytes(["Install the app.", "DB_PASSWORD=hunter2hunter2"])
        ),
      ],
      true
    );
    const result = await executeTool("read_upload", { file_id: DOC }, ctx);
    expect(result.ok).toBe(true);
    const text = JSON.stringify(toolModelOutput("read_upload", result));
    expect(text).toContain("# setup.docx");
    expect(text).toContain("Install the app.");
    expect(text).not.toContain("hunter2");
    expect(result.meta).toEqual({ fileIds: [DOC], withheld: 1 });
  });

  it("a tripped bound is a tool error, not a failed turn", async () => {
    const ctx = toolContext(
      [
        uploadRef(
          DOC,
          "brief.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          withClaimedSizes(await docxBytes(["Hi"]), 60 * MiB)
        ),
        uploadRef(PDF, "slow.pdf", "application/pdf", pdfBytes("Slow")),
      ],
      false
    );
    const zipped = await executeTool("read_upload", { file_id: DOC }, ctx);
    expect(zipped).toEqual({
      ok: false,
      error: expect.stringContaining("too large or too complex to read"),
      meta: { fileIds: [DOC] },
    });
    // A PDF whose extraction ran past its time (the worker was killed).
    vi.mocked(fileText.extractUploadText).mockRejectedValueOnce(
      new fileText.ExtractionLimitError("timeout")
    );
    const slow = await executeTool("read_upload", { file_id: PDF }, ctx);
    expect(slow.ok).toBe(false);
    expect(toolModelOutput("read_upload", slow)).toEqual({
      type: "error-text",
      value: expect.stringContaining("slow.pdf is too large or too complex"),
    });
  });

  it("marks a text file cut at the limit", async () => {
    const ctx = toolContext(
      [
        uploadRef(
          DOC,
          "big.log",
          "text/plain",
          new TextEncoder().encode("a".repeat(100_010))
        ),
      ],
      true
    );
    const result = await executeTool("read_upload", { file_id: DOC }, ctx);
    expect(result.meta).toEqual({ fileIds: [DOC], truncated: true });
    expect(JSON.stringify(toolModelOutput("read_upload", result))).toContain(
      "[truncated: the file's text exceeds 100000 characters]"
    );
  });
});

describe("the question lists its uploads", () => {
  it("names each file with its id for read_upload, on every question", () => {
    const files = [
      { id: IMG, filename: "shot.png", mediaType: "image/png", size: 64 },
    ];
    const messages = buildHistory(
      {
        messageId: "m",
        status: "queued",
        content: "",
        conversationId: CONV,
        userId: QA,
        userName: "Widya",
        preferredName: null,
        context: { kind: "auto" },
        history: [
          {
            role: "user",
            content: "Earlier",
            status: "done",
            context: { kind: "auto" },
            files,
          },
          {
            role: "assistant",
            content: "Answer",
            status: "done",
            context: null,
            files: [],
          },
          {
            role: "user",
            content: "Now",
            status: "done",
            context: { kind: "auto" },
            files,
          },
        ],
        attachmentIds: [],
        uploads: [],
      },
      "source note"
    );
    const note = `(Files uploaded with this question, readable with read_upload:\n- file_id ${IMG}: shot.png (image/png, 64 bytes))`;
    expect(JSON.stringify(messages[0])).toContain(
      JSON.stringify(note).slice(1, -1)
    );
    expect(JSON.stringify(messages[2])).toContain(
      JSON.stringify(note).slice(1, -1)
    );
  });
});
