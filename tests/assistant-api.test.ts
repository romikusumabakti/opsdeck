import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The assistant chat API end to end through the Hono app, over an in-memory
// conversation store. Authorization is simulated per project membership; the
// quota-day math (quotaDay, quotaDayResetsAt) is the real one.

const ENV_KMEM = "0197f3a0-1b2c-7def-8000-00000000e001";
const ENV_HMEM = "0197f3a0-1b2c-7def-8000-00000000e002";
const PROJECT_KMEM = "0197f3a0-1b2c-7def-8000-00000000a001";
const PROJECT_HMEM = "0197f3a0-1b2c-7def-8000-00000000a002";
const QA = "0197f3a0-1b2c-7def-8000-00000000f001";
const OTHER = "0197f3a0-1b2c-7def-8000-00000000f002";
const ADMIN = "0197f3a0-1b2c-7def-8000-00000000f003";
const UNKNOWN_ID = "0197f3a0-1b2c-7def-8000-00000000dead";

type Message = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: "queued" | "streaming" | "done" | "failed";
  errorCode: string | null;
  attachmentIds: string[];
};
type Conversation = {
  id: string;
  userId: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  title: string;
  updatedAt: Date;
};

const state = vi.hoisted(() => ({
  userId: "",
  orgRole: "qa",
  // project id -> member user ids; admins see every project.
  members: {} as Record<string, string[]>,
  runtime: null as null | { dailyCapUsd: number },
  runtimeThrows: false,
  limits: { enabled: true, hasApiKey: true, dailyCapUsd: 1.5 },
  // spend rows: what the usage table holds, by the instant it was recorded.
  spend: [] as { userId: string; at: Date; costUsd: number }[],
}));

const store = vi.hoisted(() => ({
  conversations: [] as Conversation[],
  messages: [] as Message[],
  toolCalls: [] as {
    messageId: string;
    tool: string;
    input: Record<string, unknown>;
    meta: Record<string, unknown>;
  }[],
  seq: 0,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: state.userId, role: state.orgRole },
  })),
}));

const ENV_PROJECT: Record<string, string> = {
  "0197f3a0-1b2c-7def-8000-00000000e001":
    "0197f3a0-1b2c-7def-8000-00000000a001",
  "0197f3a0-1b2c-7def-8000-00000000e002":
    "0197f3a0-1b2c-7def-8000-00000000a002",
};

vi.mock("@/lib/authz", async () => {
  const { HTTPException } = await import("hono/http-exception");
  class ForbiddenError extends HTTPException {
    constructor() {
      super(403, { message: "Forbidden" });
    }
  }
  return {
    ForbiddenError,
    requireProjectPermission: vi.fn(
      async (
        scope: { environmentId?: string; projectId?: string },
        perms: Record<string, string[]>
      ) => {
        expect(perms).toEqual({ assistant: ["use"] });
        const projectId =
          scope.projectId ?? ENV_PROJECT[scope.environmentId ?? ""];
        const visible =
          projectId &&
          (state.orgRole === "admin" ||
            (state.members[projectId] ?? []).includes(state.userId));
        if (!visible) throw new HTTPException(404, { message: "Not Found" });
        return {
          session: { user: { id: state.userId, role: state.orgRole } },
          role: "qa",
          projectId,
        };
      }
    ),
  };
});

vi.mock("@/lib/assistant/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/client")>()),
  loadAssistantRuntime: vi.fn(async () => {
    if (state.runtimeThrows) throw new Error("Unsupported state");
    return state.runtime;
  }),
}));

vi.mock("@/lib/assistant/usage", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/assistant/usage")>();
  return {
    ...real,
    // Sums the rows whose quota day (real quotaDay) is the one `now` is on.
    spentTodayUsd: vi.fn(async (userId: string, now: Date = new Date()) =>
      state.spend
        .filter(
          (s) =>
            s.userId === userId && real.quotaDay(s.at) === real.quotaDay(now)
        )
        .reduce((sum, s) => sum + s.costUsd, 0)
    ),
  };
});

const queue = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}) }));
vi.mock("@/lib/assistant/queue", () => ({
  enqueueAssistantTurn: queue.enqueue,
}));

const jira = vi.hoisted(() => ({
  visible: vi.fn(),
  list: vi.fn(),
  viewer: vi.fn(),
}));
vi.mock("@/lib/assistant/viewer", () => ({ loadAssistantViewer: jira.viewer }));
vi.mock("@/lib/assistant/tools/context", async (importOriginal) => ({
  normalizeJiraKey: (
    await importOriginal<typeof import("@/lib/assistant/tools/context")>()
  ).normalizeJiraKey,
  visibleIssueByKey: jira.visible,
  listIssueAttachments: jira.list,
}));

vi.mock("@/lib/assistant/conversation-store", async (importOriginal) => {
  const { titleFrom } =
    await importOriginal<typeof import("@/lib/assistant/conversation-store")>();
  const nextId = () =>
    `0197f3a0-1b2c-7def-8000-${String(++store.seq).padStart(12, "0")}`;
  const owner = (c: Conversation | undefined) =>
    c ? { id: c.id, userId: c.userId, projectId: c.projectId } : null;
  const callsOf = (messageId: string) =>
    store.toolCalls
      .filter((t) => t.messageId === messageId)
      .map((t) => ({ tool: t.tool, meta: t.meta }));
  return {
    titleFrom,
    loadAssistantLimits: async () => state.limits,
    environmentNameOf: async (id: string) =>
      id === ENV_KMEM ? "Dev 1" : id === ENV_HMEM ? "UAT" : null,
    listConversationsOf: async (userId: string, environmentId: string) =>
      store.conversations
        .filter((c) => c.userId === userId && c.environmentId === environmentId)
        .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
    insertConversation: async (
      v: Omit<Conversation, "id" | "title" | "updatedAt">
    ) => {
      const id = nextId();
      store.conversations.push({ ...v, id, title: "", updatedAt: new Date() });
      return id;
    },
    findConversation: async (id: string) =>
      owner(store.conversations.find((c) => c.id === id)),
    findAssistantMessageConversation: async (messageId: string) => {
      const m = store.messages.find(
        (x) => x.id === messageId && x.role === "assistant"
      );
      return owner(store.conversations.find((c) => c.id === m?.conversationId));
    },
    loadConversationDetail: async (id: string) => {
      const c = store.conversations.find((x) => x.id === id);
      if (!c) return null;
      return {
        id: c.id,
        title: c.title,
        environmentId: c.environmentId,
        environmentName: c.environmentName,
        messages: store.messages
          .filter((m) => m.conversationId === id)
          .map((m) => ({
            ...m,
            sources: null,
            createdAt: new Date(0),
            toolCalls: callsOf(m.id),
          })),
        drafts: [],
      };
    },
    insertTurn: async (p: {
      conversationId: string;
      text: string;
      attachmentIds: string[];
      now: Date;
    }) => {
      const busy = store.messages.some(
        (m) =>
          m.conversationId === p.conversationId &&
          m.role === "assistant" &&
          (m.status === "queued" || m.status === "streaming")
      );
      if (busy) return "busy";
      const base = { conversationId: p.conversationId, errorCode: null };
      const question: Message = {
        ...base,
        id: nextId(),
        role: "user",
        content: p.text,
        status: "done",
        attachmentIds: p.attachmentIds,
      };
      const answer: Message = {
        ...base,
        id: nextId(),
        role: "assistant",
        content: "",
        status: "queued",
        attachmentIds: [],
      };
      store.messages.push(question, answer);
      const c = store.conversations.find((x) => x.id === p.conversationId);
      if (c) {
        c.updatedAt = p.now;
        if (!c.title) c.title = titleFrom(p.text);
      }
      return { userMessageId: question.id, assistantMessageId: answer.id };
    },
    failQueuedMessage: async (id: string, errorCode: string) => {
      const m = store.messages.find((x) => x.id === id);
      if (m?.status === "queued")
        Object.assign(m, { status: "failed", errorCode });
    },
    readStreamSnapshot: async (id: string) => {
      const m = store.messages.find((x) => x.id === id);
      return m
        ? {
            content: m.content,
            status: m.status,
            errorCode: m.errorCode,
            toolCalls: callsOf(id),
          }
        : null;
    },
  };
});

const { app } = await import("@/server/app");

const BASE = "/api/assistant";

function get(path: string) {
  return app.request(`${BASE}${path}`);
}

function post(path: string, body: unknown) {
  return app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function as(userId: string, orgRole = "qa") {
  state.userId = userId;
  state.orgRole = orgRole;
}

async function newConversation(environmentId = ENV_KMEM): Promise<string> {
  const res = await post("/create-conversation", { environmentId });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

function send(
  conversationId: string,
  text = "Bagaimana iuran dihitung?",
  extra = {}
) {
  return post("/send-message", { conversationId, text, ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.conversations = [];
  store.messages = [];
  store.toolCalls = [];
  state.members = { [PROJECT_KMEM]: [QA, OTHER], [PROJECT_HMEM]: [OTHER] };
  state.runtime = { dailyCapUsd: 1.5 };
  state.runtimeThrows = false;
  state.limits = { enabled: true, hasApiKey: true, dailyCapUsd: 1.5 };
  state.spend = [];
  as(QA);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("project scope", () => {
  it("a qa who is not a member of another project gets 404 on its environment", async () => {
    expect(
      (await get(`/list-conversations?environmentId=${ENV_HMEM}`)).status
    ).toBe(404);
    expect(
      (await post("/create-conversation", { environmentId: ENV_HMEM })).status
    ).toBe(404);
    expect(
      (
        await get(
          `/list-issue-attachments?environmentId=${ENV_HMEM}&issueKey=HMEM-1`
        )
      ).status
    ).toBe(404);
    expect(store.conversations).toEqual([]);
  });

  it("lists only the caller's own conversations of the environment", async () => {
    const mine = await newConversation();
    as(OTHER);
    await newConversation();
    as(QA);
    const res = await get(`/list-conversations?environmentId=${ENV_KMEM}`);
    expect((await res.json()).map((c: { id: string }) => c.id)).toEqual([mine]);
  });
});

describe("conversation ownership", () => {
  it("another user's conversation is 404", async () => {
    as(OTHER);
    const theirs = await newConversation();
    await send(theirs);
    const answerId = store.messages[1]?.id;
    for (const user of [QA, ADMIN]) {
      as(user, user === ADMIN ? "admin" : "qa");
      expect(
        (await get(`/get-conversation?conversationId=${theirs}`)).status
      ).toBe(404);
      expect((await send(theirs)).status).toBe(404);
      expect((await get(`/stream?messageId=${answerId}`)).status).toBe(404);
    }
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("an unknown conversation or message is 404", async () => {
    expect(
      (await get(`/get-conversation?conversationId=${UNKNOWN_ID}`)).status
    ).toBe(404);
    expect((await send(UNKNOWN_ID)).status).toBe(404);
    expect((await get(`/stream?messageId=${UNKNOWN_ID}`)).status).toBe(404);
  });

  it("the owner loses their conversation with their project membership", async () => {
    const id = await newConversation();
    state.members[PROJECT_KMEM] = [OTHER];
    expect((await get(`/get-conversation?conversationId=${id}`)).status).toBe(
      404
    );
    expect((await send(id)).status).toBe(404);
  });

  it("the stream of a user message is 404 (only answers stream)", async () => {
    const id = await newConversation();
    await send(id);
    const question = store.messages.find((m) => m.role === "user");
    expect((await get(`/stream?messageId=${question?.id}`)).status).toBe(404);
  });
});

describe("send-message", () => {
  it("enqueues exactly one job with jobId = the assistant message id", async () => {
    const id = await newConversation();
    const res = await send(id, "  Bagaimana iuran dihitung?  ", {
      attachmentIds: ["10001", "10001", "10002"],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith(
      body.assistantMessageId
    );
    const [question, answer] = store.messages;
    expect(question).toMatchObject({
      id: body.userMessageId,
      role: "user",
      status: "done",
      content: "Bagaimana iuran dihitung?",
      attachmentIds: ["10001", "10002"],
    });
    expect(answer).toMatchObject({
      id: body.assistantMessageId,
      role: "assistant",
      status: "queued",
    });
  });

  it("titles the conversation from the first message only (80 chars)", async () => {
    const id = await newConversation();
    const long = `${"a".repeat(79)}é and more`;
    await send(id, long);
    store.messages[1]!.status = "done";
    await send(id, "second question");
    expect(store.conversations[0]?.title).toBe(`${"a".repeat(79)}é`);
  });

  it("refuses while the previous answer is streaming: assistant.busy", async () => {
    const id = await newConversation();
    await send(id);
    store.messages[1]!.status = "streaming";
    const res = await send(id, "again");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "assistant.busy" });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(store.messages).toHaveLength(2);
  });

  it("refuses at the daily cap: assistant.daily_cap_reached with capUsd and resetsAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-11-16 10:00 WIB
    vi.setSystemTime(new Date("2026-11-16T03:00:00Z"));
    state.spend = [
      { userId: QA, at: new Date("2026-11-16T01:00:00Z"), costUsd: 1.5 },
    ];
    const id = await newConversation();
    const res = await send(id);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "assistant.daily_cap_reached",
      params: { capUsd: 1.5, resetsAt: "2026-11-16T17:00:00.000Z" },
    });
    expect(body.error).toContain("1.5");
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(store.messages).toEqual([]);
  });

  it("refuses when the assistant is off or its key cannot be decrypted: assistant.not_configured", async () => {
    const id = await newConversation();
    state.runtime = null;
    const off = await send(id);
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({
      code: "assistant.not_configured",
    });
    state.runtime = { dailyCapUsd: 1.5 };
    state.runtimeThrows = true;
    const broken = await send(id);
    expect(await broken.json()).toMatchObject({
      code: "assistant.not_configured",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("fails the queued answer when the job cannot be enqueued", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue.enqueue.mockRejectedValueOnce(new Error("redis down"));
    const id = await newConversation();
    const res = await send(id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "assistant.unavailable" });
    expect(store.messages[1]).toMatchObject({
      status: "failed",
      errorCode: "assistant.unavailable",
    });
    // Not busy afterwards: the user can send again.
    expect((await send(id)).status).toBe(200);
  });

  it("validates text and attachment ids", async () => {
    const id = await newConversation();
    expect((await send(id, "   ")).status).toBe(400);
    expect((await send(id, "x".repeat(8001))).status).toBe(400);
    expect((await send(id, "q", { attachmentIds: ["../etc"] })).status).toBe(
      400
    );
    const eleven = Array.from({ length: 11 }, (_, i) => String(10000 + i));
    expect((await send(id, "q", { attachmentIds: eleven })).status).toBe(400);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe("get-conversation", () => {
  it("returns messages with tool-call metas but never tool inputs, and drafts", async () => {
    const id = await newConversation();
    await send(id);
    const answer = store.messages[1]!;
    store.toolCalls.push({
      messageId: answer.id,
      tool: "read_file",
      input: { path: "backend/secret-input-marker.java" },
      meta: { paths: ["backend/Iuran.java"] },
    });
    const res = await get(`/get-conversation?conversationId=${id}`);
    const text = await res.text();
    expect(text).not.toContain("secret-input-marker");
    const body = JSON.parse(text);
    expect(body.drafts).toEqual([]);
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      status: "queued",
      errorCode: null,
      toolCalls: [
        { tool: "read_file", meta: { paths: ["backend/Iuran.java"] } },
      ],
    });
  });
});

describe("stream", () => {
  it("sends snapshots until the answer is done", async () => {
    const id = await newConversation();
    await send(id);
    const answer = store.messages[1]!;
    Object.assign(answer, { status: "done", content: "Iuran dihitung di X." });
    const res = await get(`/stream?messageId=${answer.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain(
      JSON.stringify({
        content: "Iuran dihitung di X.",
        status: "done",
        errorCode: null,
        toolCalls: [],
      })
    );
  });
});

describe("allowance", () => {
  it("is open to any signed-in user and reports enabled only with a key", async () => {
    as(ADMIN, "observer");
    state.limits = { enabled: true, hasApiKey: false, dailyCapUsd: 1.5 };
    const res = await get("/allowance");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, capUsd: 1.5 });
  });

  it("counts spend at 23:59 WIB for that day and resets at 00:01 WIB", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:59 WIB on 2026-11-16 is 16:59 UTC.
    state.spend = [
      { userId: QA, at: new Date("2026-11-16T16:59:00Z"), costUsd: 0.4 },
      { userId: OTHER, at: new Date("2026-11-16T16:59:00Z"), costUsd: 1 },
    ];
    vi.setSystemTime(new Date("2026-11-16T16:59:30Z"));
    expect(await (await get("/allowance")).json()).toEqual({
      enabled: true,
      capUsd: 1.5,
      spentUsd: 0.4,
      remainingUsd: 1.1,
      resetsAt: "2026-11-16T17:00:00.000Z",
    });

    // 00:01 WIB on 2026-11-17.
    vi.setSystemTime(new Date("2026-11-16T17:01:00Z"));
    expect(await (await get("/allowance")).json()).toEqual({
      enabled: true,
      capUsd: 1.5,
      spentUsd: 0,
      remainingUsd: 1.5,
      resetsAt: "2026-11-17T17:00:00.000Z",
    });
  });

  it("never reports a negative remainder", async () => {
    state.spend = [{ userId: QA, at: new Date(), costUsd: 2.25 }];
    expect(await (await get("/allowance")).json()).toMatchObject({
      spentUsd: 2.25,
      remainingUsd: 0,
    });
  });
});

describe("list-issue-attachments", () => {
  it("lists the attachments of an issue visible to the caller", async () => {
    const visible = { issue: { id: "i1", jiraKey: "KMEM-12" }, link: null };
    jira.viewer.mockResolvedValue({ userId: QA, projectIds: [PROJECT_KMEM] });
    jira.visible.mockResolvedValue(visible);
    jira.list.mockResolvedValue({
      attachments: [
        {
          id: "10001",
          filename: "brd.pdf",
          mime: "application/pdf",
          sizeBytes: 9,
        },
      ],
      error: null,
    });
    const res = await get(
      `/list-issue-attachments?environmentId=${ENV_KMEM}&issueKey=kmem-12`
    );
    expect(await res.json()).toEqual({
      key: "KMEM-12",
      attachments: [
        {
          id: "10001",
          filename: "brd.pdf",
          mime: "application/pdf",
          sizeBytes: 9,
        },
      ],
      unavailable: false,
    });
    expect(jira.viewer).toHaveBeenCalledWith(QA);
    expect(jira.visible).toHaveBeenCalledWith(
      { userId: QA, projectIds: [PROJECT_KMEM] },
      "KMEM-12"
    );
    expect(jira.list).toHaveBeenCalledWith(visible);
  });

  it("is 404 for an issue outside the caller's visible projects, without a Jira call", async () => {
    jira.viewer.mockResolvedValue({ userId: QA, projectIds: [PROJECT_KMEM] });
    jira.visible.mockResolvedValue(null);
    const res = await get(
      `/list-issue-attachments?environmentId=${ENV_KMEM}&issueKey=HMEM-3`
    );
    expect(res.status).toBe(404);
    expect(jira.list).not.toHaveBeenCalled();
  });

  it("reports an unavailable list instead of Jira's error text", async () => {
    jira.viewer.mockResolvedValue({ userId: QA, projectIds: [PROJECT_KMEM] });
    jira.visible.mockResolvedValue({ issue: { id: "i1" }, link: null });
    jira.list.mockResolvedValue({
      attachments: [],
      error: "Jira request failed (HTTP 500)",
    });
    const res = await get(
      `/list-issue-attachments?environmentId=${ENV_KMEM}&issueKey=KMEM-12`
    );
    const text = await res.text();
    expect(text).not.toContain("HTTP 500");
    expect(JSON.parse(text)).toMatchObject({
      attachments: [],
      unavailable: true,
    });
  });
});
