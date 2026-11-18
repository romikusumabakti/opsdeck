import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The assistant chat API end to end through the Hono app, over an in-memory
// conversation store. Authorization is simulated per project membership; the
// quota-day math (quotaDay, quotaDayResetsAt) is the real one.

const ENV_KMEM = "0197f3a0-1b2c-7def-8000-00000000e001";
const ENV_HMEM = "0197f3a0-1b2c-7def-8000-00000000e002";
// Found by the send-time check, deleted before the insert (a race).
const ENV_RACED = "0197f3a0-1b2c-7def-8000-00000000e003";
const PROJECT_KMEM = "0197f3a0-1b2c-7def-8000-00000000a001";
const PROJECT_HMEM = "0197f3a0-1b2c-7def-8000-00000000a002";
const QA = "0197f3a0-1b2c-7def-8000-00000000f001";
const OTHER = "0197f3a0-1b2c-7def-8000-00000000f002";
const ADMIN = "0197f3a0-1b2c-7def-8000-00000000f003";
const LONER = "0197f3a0-1b2c-7def-8000-00000000f004";
const UNKNOWN_ID = "0197f3a0-1b2c-7def-8000-00000000dead";

type Message = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: "queued" | "streaming" | "done" | "failed";
  errorCode: string | null;
  attachmentIds: string[];
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  environmentName: string | null;
};
type Conversation = {
  id: string;
  userId: string;
  // Stage 2 conversations keep their project; new ones have none.
  projectId: string | null;
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
  // project members whose project role is viewer (no issue:write).
  viewers: [] as string[],
  // project id -> its Jira link's write-back switch (no entry: no link).
  jiraPush: {} as Record<string, boolean>,
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
  drafts: [] as {
    id: string;
    conversationId: string;
    projectId: string | null;
    kind: "brd" | "jira";
    content: Record<string, unknown>;
    issueId: string | null;
  }[],
  // Uploaded files of a chat, by their storage key.
  files: [] as { conversationId: string; storageKey: string }[],
  // draft id -> the Jira issue an earlier failed create left unlinked.
  unlinked: {} as Record<
    string,
    { jiraIssueId: string; jiraKey: string; projectId: string | null }
  >,
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
  "0197f3a0-1b2c-7def-8000-00000000e003":
    "0197f3a0-1b2c-7def-8000-00000000a001",
};
const ENV_NAME: Record<string, string> = {
  "0197f3a0-1b2c-7def-8000-00000000e001": "Dev 1",
  "0197f3a0-1b2c-7def-8000-00000000e002": "UAT",
  "0197f3a0-1b2c-7def-8000-00000000e003": "Raced",
};
const PROJECT_NAME: Record<string, string> = {
  "0197f3a0-1b2c-7def-8000-00000000a001": "Kestrel Membership",
  "0197f3a0-1b2c-7def-8000-00000000a002": "Heron Membership",
};

vi.mock("@/lib/authz", async () => {
  const { HTTPException } = await import("hono/http-exception");
  class ForbiddenError extends HTTPException {
    constructor() {
      super(403, { message: "Forbidden" });
    }
  }
  const sees = (projectId: string) =>
    state.orgRole === "admin" ||
    (state.members[projectId] ?? []).includes(state.userId);
  return {
    ForbiddenError,
    accessibleProjectIds: vi.fn(async () =>
      state.orgRole === "admin"
        ? "all"
        : Object.keys(state.members).filter((id) => sees(id))
    ),
    getProjectAccess: vi.fn(async () => ({
      all: state.orgRole === "admin",
      roles: Object.fromEntries(
        Object.keys(PROJECT_NAME)
          .filter((id) => sees(id))
          .map((id) => [
            id,
            state.viewers.includes(state.userId) ? "viewer" : "qa",
          ])
      ),
    })),
    requireProjectPermission: vi.fn(
      async (
        scope: { environmentId?: string; projectId?: string },
        perms: Record<string, string[]>
      ) => {
        // assistant:use everywhere; creating a Jira issue adds issue:write.
        expect([
          JSON.stringify({ assistant: ["use"] }),
          JSON.stringify({ issue: ["write"] }),
        ]).toContain(JSON.stringify(perms));
        const projectId =
          scope.projectId ?? ENV_PROJECT[scope.environmentId ?? ""];
        if (!projectId || !sees(projectId)) {
          throw new HTTPException(404, { message: "Not Found" });
        }
        if (perms.issue && state.viewers.includes(state.userId)) {
          throw new ForbiddenError();
        }
        return {
          session: { user: { id: state.userId, role: state.orgRole } },
          role: "qa",
          projectId,
        };
      }
    ),
  };
});

vi.mock("@/lib/assistant/client", async (importOriginal) => {
  const load = async () => {
    if (state.runtimeThrows) throw new Error("Unsupported state");
    return state.runtime;
  };
  return {
    ...(await importOriginal<typeof import("@/lib/assistant/client")>()),
    loadAssistantRuntime: vi.fn(load),
  };
});

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
  const { titleFrom, TITLE_MAX_CHARS } =
    await importOriginal<typeof import("@/lib/assistant/conversation-store")>();
  const { contextFromRow, contextListLabel, messageContextOf } = await import(
    "@/lib/assistant/context"
  );
  const nextId = () =>
    `0197f3a0-1b2c-7def-8000-${String(++store.seq).padStart(12, "0")}`;
  const owner = (c: Conversation | undefined) =>
    c ? { id: c.id, userId: c.userId } : null;
  const callsOf = (messageId: string) =>
    store.toolCalls
      .filter((t) => t.messageId === messageId)
      .map((t) => ({ tool: t.tool, meta: t.meta }));
  const lastQuestion = (conversationId: string) =>
    store.messages.findLast(
      (m) => m.conversationId === conversationId && m.role === "user"
    );
  return {
    titleFrom,
    TITLE_MAX_CHARS,
    loadAssistantLimits: async () => state.limits,
    findProject: async (id: string) =>
      PROJECT_NAME[id] ? { id, name: PROJECT_NAME[id] } : null,
    findEnvironment: async (id: string) => {
      const projectId = ENV_PROJECT[id];
      const name = ENV_NAME[id];
      return projectId && name
        ? {
            id,
            name,
            projectId,
            projectName: PROJECT_NAME[projectId] ?? "",
          }
        : null;
    },
    listConversationsOf: async (userId: string) =>
      store.conversations
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((c) => {
          const last = lastQuestion(c.id);
          return {
            id: c.id,
            title: c.title,
            updatedAt: c.updatedAt,
            lastContextLabel: last ? contextListLabel(last).label : null,
            lastContextDeleted: last ? contextListLabel(last).deleted : false,
          };
        }),
    insertConversation: async (v: { userId: string }) => {
      const id = nextId();
      store.conversations.push({
        userId: v.userId,
        projectId: null,
        id,
        title: "",
        updatedAt: new Date(),
      });
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
        messages: store.messages
          .filter((m) => m.conversationId === id)
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            status: m.status,
            errorCode: m.errorCode,
            attachmentIds: m.attachmentIds,
            context: m.role === "user" ? messageContextOf(m) : null,
            sources: null,
            createdAt: new Date(0),
            toolCalls: callsOf(m.id),
          })),
        drafts: store.drafts
          .filter((d) => d.conversationId === id)
          .map((d) => ({
            id: d.id,
            kind: d.kind,
            content: d.content,
            issueId: d.issueId,
            projectId: d.projectId,
            jiraKey: d.issueId ? "KST-901" : null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          })),
      };
    },
    insertTurn: async (p: {
      conversationId: string;
      text: string;
      attachmentIds: string[];
      context:
        | { kind: "auto" }
        | { kind: "project"; projectId: string; projectName: string }
        | {
            kind: "environment";
            environmentId: string;
            environmentName: string;
            projectId: string;
            projectName: string;
          };
      now: Date;
    }) => {
      const busy = store.messages.some(
        (m) =>
          m.conversationId === p.conversationId &&
          m.role === "assistant" &&
          (m.status === "queued" || m.status === "streaming")
      );
      if (busy) return "busy";
      if (
        p.context.kind === "environment" &&
        p.context.environmentId === ENV_RACED
      ) {
        return "context_gone";
      }
      const base = { conversationId: p.conversationId, errorCode: null };
      const ctx = p.context;
      const question: Message = {
        ...base,
        id: nextId(),
        role: "user",
        content: p.text,
        status: "done",
        attachmentIds: p.attachmentIds,
        projectId: ctx.kind === "auto" ? null : ctx.projectId,
        projectName: ctx.kind === "auto" ? null : ctx.projectName,
        environmentId: ctx.kind === "environment" ? ctx.environmentId : null,
        environmentName:
          ctx.kind === "environment" ? ctx.environmentName : null,
      };
      const answer: Message = {
        ...base,
        projectId: null,
        projectName: null,
        environmentId: null,
        environmentName: null,
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
    updateConversationTitle: async (id: string, title: string) => {
      const c = store.conversations.find((x) => x.id === id);
      if (c) c.title = title;
    },
    // Like the cascade: messages, their tool calls, drafts and files go.
    deleteConversationRows: async (id: string) => {
      const messageIds = new Set(
        store.messages.filter((m) => m.conversationId === id).map((m) => m.id)
      );
      const keys = store.files
        .filter((f) => f.conversationId === id)
        .map((f) => f.storageKey);
      store.conversations = store.conversations.filter((c) => c.id !== id);
      store.messages = store.messages.filter((m) => m.conversationId !== id);
      store.toolCalls = store.toolCalls.filter(
        (t) => !messageIds.has(t.messageId)
      );
      store.drafts = store.drafts.filter((d) => d.conversationId !== id);
      store.files = store.files.filter((f) => f.conversationId !== id);
      return keys;
    },
    failQueuedMessage: async (id: string, errorCode: string) => {
      const m = store.messages.find((x) => x.id === id);
      if (m?.status === "queued")
        Object.assign(m, { status: "failed", errorCode });
    },
    lastQuestionContext: async (conversationId: string) => {
      const q = lastQuestion(conversationId);
      return q ? contextFromRow(q) : null;
    },
    replaceLastAnswer: async (conversationId: string) => {
      const mine = store.messages.filter(
        (x) => x.conversationId === conversationId
      );
      const last = mine.at(-1);
      if (last?.role !== "assistant") return "nothing_to_retry";
      if (last.status === "queued" || last.status === "streaming")
        return "busy";
      store.messages = store.messages.filter((x) => x !== last);
      store.toolCalls = store.toolCalls.filter((t) => t.messageId !== last.id);
      const answer: Message = {
        conversationId,
        errorCode: null,
        projectId: null,
        projectName: null,
        environmentId: null,
        environmentName: null,
        id: nextId(),
        role: "assistant",
        content: "",
        status: "queued",
        attachmentIds: [],
      };
      store.messages.push(answer);
      return { assistantMessageId: answer.id };
    },
    stopPendingAnswer: async (conversationId: string) => {
      const m = store.messages.find(
        (x) =>
          x.conversationId === conversationId &&
          x.role === "assistant" &&
          (x.status === "queued" || x.status === "streaming")
      );
      if (!m) return null;
      Object.assign(m, { status: "failed", errorCode: "assistant.stopped" });
      return m.id;
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

const storage = vi.hoisted(() => ({ deleteObject: vi.fn(async () => {}) }));
vi.mock("@/lib/storage", () => storage);

const drafting = vi.hoisted(() => ({
  generate: vi.fn(),
  create: vi.fn(),
  suggest: vi.fn(),
}));

vi.mock("@/lib/assistant/draft-store", () => ({
  findDraftOwner: async (draftId: string) => {
    const d = store.drafts.find((x) => x.id === draftId);
    const c = store.conversations.find((x) => x.id === d?.conversationId);
    return d && c
      ? {
          conversation: { id: c.id, userId: c.userId },
          projectId: d.projectId,
          kind: d.kind,
          issueId: d.issueId,
        }
      : null;
  },
  updateDraftContent: async (
    draftId: string,
    content: Record<string, unknown>,
    options: { projectId?: string } = {}
  ) => {
    const d = store.drafts.find((x) => x.id === draftId && !x.issueId);
    if (d) {
      d.content = content;
      if (options.projectId) d.projectId = options.projectId;
    }
    return !!d;
  },
  suggestDraftProject: drafting.suggest,
  findUnlinkedRemoteOf: async (draftId: string) =>
    store.unlinked[draftId] ?? null,
  loadDraftProjects: async (ids: string[]) =>
    Object.entries(PROJECT_NAME)
      .filter(([id]) => ids.includes(id))
      .map(([id, name]) => ({
        id,
        key: id === PROJECT_KMEM ? "KMEM" : "HMEM",
        name,
        jiraPushEnabled: state.jiraPush[id] ?? false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
}));

vi.mock("@/lib/assistant/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/drafts")>()),
  generateDraft: drafting.generate,
}));

vi.mock("@/lib/jira/create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/create")>()),
  createJiraIssueFromDraft: drafting.create,
}));

const { app } = await import("@/server/app");
const { TurnError } = await import("@/lib/assistant/run-turn");
const { JiraCreateError } = await import("@/lib/jira/create");

const BASE = "/api/assistant";

const JIRA_DRAFT = {
  summary: "Iuran tambahan dibulatkan ke atas",
  issueType: "Story",
  description: "Saat ini dibulatkan ke bawah.",
  acceptanceCriteria: ["Dibulatkan ke atas"],
};

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

async function newConversation(): Promise<string> {
  const res = await post("/create-conversation", {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const PINNED_KMEM = { kind: "project", projectId: PROJECT_KMEM };

function send(
  conversationId: string,
  text = "Bagaimana iuran dihitung?",
  extra = {}
) {
  return post("/send-message", {
    conversationId,
    text,
    context: PINNED_KMEM,
    ...extra,
  });
}

/** A Stage 2 conversation: bound to a project, its questions backfilled. */
function stage2Conversation(
  id: string,
  userId: string,
  projectId: string,
  at: string
) {
  store.conversations.push({
    id,
    userId,
    projectId,
    title: `Stage 2 ${id}`,
    updatedAt: new Date(at),
  });
  store.messages.push({
    id: `${id}-q`,
    conversationId: id,
    role: "user",
    content: "Old question",
    status: "done",
    errorCode: null,
    attachmentIds: [],
    projectId,
    projectName: PROJECT_NAME[projectId] ?? null,
    environmentId: null,
    environmentName: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.conversations = [];
  store.messages = [];
  store.toolCalls = [];
  store.drafts = [];
  store.files = [];
  store.unlinked = {};
  state.viewers = [];
  state.jiraPush = { [PROJECT_KMEM]: true };
  drafting.suggest.mockResolvedValue(PROJECT_KMEM);
  drafting.generate.mockImplementation(
    async (
      conversationId: string,
      kind: "brd" | "jira",
      _userId: string,
      deps: { projectId: string | null }
    ) => {
      const id = `0197f3a0-1b2c-7def-8000-${String(++store.seq).padStart(12, "0")}`;
      store.drafts.push({
        id,
        conversationId,
        projectId: deps.projectId,
        kind,
        content:
          kind === "jira" ? { ...JIRA_DRAFT } : { title: "T", sections: [] },
        issueId: null,
      });
      return { draftId: id };
    }
  );
  drafting.create.mockImplementation(async (draftId: string) => {
    const d = store.drafts.find((x) => x.id === draftId);
    if (d) d.issueId = "0197f3a0-1b2c-7def-8000-0000000011ee";
    return {
      issueId: "0197f3a0-1b2c-7def-8000-0000000011ee",
      jiraKey: "KST-901",
    };
  });
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

describe("global gate", () => {
  it("creates a conversation without a project", async () => {
    const id = await newConversation();
    expect(store.conversations).toEqual([
      expect.objectContaining({ id, userId: QA, projectId: null }),
    ]);
  });

  it("refuses list, create and get to a user who sees no project", async () => {
    const id = await newConversation();
    as(LONER, "engineer");
    expect((await get("/list-conversations")).status).toBe(403);
    expect((await post("/create-conversation", {})).status).toBe(403);
    expect((await get("/list-issue-attachments?issueKey=KMEM-12")).status).toBe(
      403
    );
    as(QA);
    state.members = {};
    expect((await get("/list-conversations")).status).toBe(403);
    expect((await get(`/get-conversation?conversationId=${id}`)).status).toBe(
      403
    );
    expect(
      (await send(id, "Tanya", { context: { kind: "auto" } })).status
    ).toBe(403);
    expect((await post("/stop-answer", { conversationId: id })).status).toBe(
      403
    );
    expect((await post("/retry-answer", { conversationId: id })).status).toBe(
      403
    );
    expect(store.conversations).toHaveLength(1);
    expect(store.messages).toEqual([]);
  });

  it.each([
    ["off", { enabled: false, hasApiKey: true, dailyCapUsd: 1.5 }],
    ["without a key", { enabled: true, hasApiKey: false, dailyCapUsd: 1.5 }],
  ])(
    "refuses list and create while the assistant is %s: assistant.not_configured",
    async (_label, limits) => {
      state.limits = limits;
      for (const res of [
        await get("/list-conversations"),
        await post("/create-conversation", {}),
        await get("/list-issue-attachments?issueKey=KMEM-12"),
      ]) {
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          code: "assistant.not_configured",
        });
      }
      expect(store.conversations).toEqual([]);
    }
  );

  it("the old project-bound endpoints are gone", async () => {
    expect((await get("/last-project")).status).toBe(404);
  });
});

describe("list-conversations", () => {
  it("lists the caller's own conversations across projects, newest first, with Stage 2 ones", async () => {
    as(OTHER);
    const kmem = await newConversation();
    expect((await send(kmem, "Di Kestrel?")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    const hmem = await newConversation();
    expect(
      (
        await send(hmem, "Di UAT?", {
          context: { kind: "environment", environmentId: ENV_HMEM },
        })
      ).status
    ).toBe(200);
    vi.useRealTimers();
    stage2Conversation("stage2", OTHER, PROJECT_KMEM, "2000-01-01T00:00:00Z");
    // Someone else's conversation never shows.
    stage2Conversation("theirs", QA, PROJECT_KMEM, "2050-01-01T00:00:00Z");

    const res = await get("/list-conversations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      lastContextLabel: string | null;
    }[];
    expect(body.map((c) => [c.id, c.lastContextLabel])).toEqual([
      [hmem, "Heron Membership · UAT"],
      [kmem, "Kestrel Membership"],
      ["stage2", "Kestrel Membership"],
    ]);
  });

  it("an empty conversation or an automatic question has no context label", async () => {
    const empty = await newConversation();
    const auto = await newConversation();
    await send(auto, "Apa saja?", { context: { kind: "auto" } });
    const body = (await (await get("/list-conversations")).json()) as {
      id: string;
      lastContextLabel: string | null;
    }[];
    expect(
      Object.fromEntries(body.map((c) => [c.id, c.lastContextLabel]))
    ).toEqual({ [empty]: null, [auto]: null });
  });
});

describe("per-question context", () => {
  it("stores a pinned environment with its project on the user message", async () => {
    const id = await newConversation();
    const res = await send(id, "Di Dev 1?", {
      context: { kind: "environment", environmentId: ENV_KMEM },
    });
    expect(res.status).toBe(200);
    expect(store.messages[0]).toMatchObject({
      role: "user",
      projectId: PROJECT_KMEM,
      projectName: "Kestrel Membership",
      environmentId: ENV_KMEM,
      environmentName: "Dev 1",
    });
    expect(store.messages[1]).toMatchObject({
      role: "assistant",
      projectId: null,
      environmentId: null,
    });
  });

  it("stores a pinned project without an environment", async () => {
    const id = await newConversation();
    expect((await send(id)).status).toBe(200);
    expect(store.messages[0]).toMatchObject({
      projectId: PROJECT_KMEM,
      projectName: "Kestrel Membership",
      environmentId: null,
      environmentName: null,
    });
  });

  it("stores nothing for an automatic question", async () => {
    const id = await newConversation();
    expect((await send(id, "Apa?", { context: { kind: "auto" } })).status).toBe(
      200
    );
    expect(store.messages[0]).toMatchObject({
      projectId: null,
      projectName: null,
      environmentId: null,
      environmentName: null,
    });
  });

  it.each([
    ["an invisible project", { kind: "project", projectId: PROJECT_HMEM }],
    ["an unknown project", { kind: "project", projectId: UNKNOWN_ID }],
    [
      "an environment of an invisible project",
      { kind: "environment", environmentId: ENV_HMEM },
    ],
    [
      "an unknown environment",
      { kind: "environment", environmentId: UNKNOWN_ID },
    ],
  ])("pinning %s is 404, nothing stored", async (_label, context) => {
    const id = await newConversation();
    expect((await send(id, "Tanya", { context })).status).toBe(404);
    expect(store.messages).toEqual([]);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("an environment deleted between the check and the insert is 404", async () => {
    const id = await newConversation();
    const res = await send(id, "Tanya", {
      context: { kind: "environment", environmentId: ENV_RACED },
    });
    expect(res.status).toBe(404);
    expect(store.messages).toEqual([]);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("requires a valid context (the Stage 2 environmentId alone is refused)", async () => {
    const id = await newConversation();
    expect(
      (
        await post("/send-message", {
          conversationId: id,
          text: "x",
          environmentId: null,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await post("/send-message", {
          conversationId: id,
          text: "x",
          context: { kind: "project" },
        })
      ).status
    ).toBe(400);
    expect(store.messages).toEqual([]);
  });

  it("returns each user message's context and marks a deleted one", async () => {
    const id = await newConversation();
    const done = (i: number) =>
      Object.assign(store.messages[i] ?? {}, { status: "done" });
    await send(id, "Di Dev 1?", {
      context: { kind: "environment", environmentId: ENV_KMEM },
    });
    done(1);
    await send(id, "Di branch?");
    done(3);
    await send(id, "Otomatis?", { context: { kind: "auto" } });
    done(5);
    await send(id, "Di Dev 1 lama?", {
      context: { kind: "environment", environmentId: ENV_KMEM },
    });
    done(7);
    await send(id, "Di project lama?");
    // Deleted since: the FKs are set null, the name snapshots stay.
    Object.assign(store.messages[6] ?? {}, { environmentId: null });
    Object.assign(store.messages[8] ?? {}, { projectId: null });

    const res = await get(`/get-conversation?conversationId=${id}`);
    const body = (await res.json()) as {
      projectId?: string;
      messages: { role: string; context: unknown }[];
    };
    expect(body).not.toHaveProperty("projectId");
    expect(body.messages.filter((m) => m.role === "assistant")).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({ context: null })
      )
    );
    expect(
      body.messages.filter((m) => m.role === "user").map((m) => m.context)
    ).toEqual([
      {
        kind: "environment",
        label: "Dev 1",
        deleted: false,
        projectId: PROJECT_KMEM,
        environmentId: ENV_KMEM,
      },
      {
        kind: "project",
        label: "Kestrel Membership",
        deleted: false,
        projectId: PROJECT_KMEM,
        environmentId: null,
      },
      {
        kind: "auto",
        label: null,
        deleted: false,
        projectId: null,
        environmentId: null,
      },
      {
        kind: "environment",
        label: "Dev 1",
        deleted: true,
        projectId: PROJECT_KMEM,
        environmentId: null,
      },
      {
        kind: "project",
        label: "Kestrel Membership",
        deleted: true,
        projectId: null,
        environmentId: null,
      },
    ]);
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

  it("a Stage 2 conversation stays readable, and answerable elsewhere, after its project is lost", async () => {
    stage2Conversation(
      "0197f3a0-1b2c-7def-8000-0000000c0002",
      OTHER,
      PROJECT_HMEM,
      "2026-11-16T01:00:00Z"
    );
    as(OTHER);
    state.members[PROJECT_HMEM] = [];
    const id = "0197f3a0-1b2c-7def-8000-0000000c0002";
    const res = await get(`/get-conversation?conversationId=${id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).messages[0].context).toMatchObject({
      kind: "project",
      label: "Heron Membership",
    });
    // Pinning the lost project again is refused; another context works.
    expect(
      (
        await send(id, "Lagi", {
          context: { kind: "project", projectId: PROJECT_HMEM },
        })
      ).status
    ).toBe(404);
    expect((await send(id, "Di Kestrel?")).status).toBe(200);
  });

  it("the stream of a user message is 404 (only answers stream)", async () => {
    const id = await newConversation();
    await send(id);
    const question = store.messages.find((m) => m.role === "user");
    expect((await get(`/stream?messageId=${question?.id}`)).status).toBe(404);
  });

  it("an engineer who is not a member of another project cannot list its attachments", async () => {
    as(QA, "engineer");
    jira.viewer.mockResolvedValue({ userId: QA, projectIds: [PROJECT_KMEM] });
    jira.visible.mockResolvedValue(null);
    expect((await get("/list-issue-attachments?issueKey=HMEM-1")).status).toBe(
      404
    );
    expect(jira.list).not.toHaveBeenCalled();
  });
});

describe("retry-answer", () => {
  it("replaces the last answer and enqueues the new one", async () => {
    const id = await newConversation();
    await send(id);
    store.messages[1]!.status = "done";
    queue.enqueue.mockClear();
    const res = await post("/retry-answer", { conversationId: id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]).toMatchObject({
      id: body.assistantMessageId,
      role: "assistant",
      status: "queued",
    });
    expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith(
      body.assistantMessageId
    );
  });

  it("accepts a stopped answer", async () => {
    const id = await newConversation();
    await send(id);
    await post("/stop-answer", { conversationId: id });
    const res = await post("/retry-answer", { conversationId: id });
    expect(res.status).toBe(200);
    expect(store.messages[1]?.status).toBe("queued");
  });

  it("refuses a pending answer (busy) and a chat without one", async () => {
    const id = await newConversation();
    const empty = await post("/retry-answer", { conversationId: id });
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({
      code: "assistant.nothing_to_retry",
    });
    await send(id);
    queue.enqueue.mockClear();
    const busy = await post("/retry-answer", { conversationId: id });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "assistant.busy" });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("is a 404 for another user's or an unknown chat", async () => {
    as(OTHER);
    const theirs = await newConversation();
    await send(theirs);
    store.messages[1]!.status = "done";
    as(QA);
    expect(
      (await post("/retry-answer", { conversationId: theirs })).status
    ).toBe(404);
    expect(
      (await post("/retry-answer", { conversationId: UNKNOWN_ID })).status
    ).toBe(404);
    expect(store.messages[1]?.status).toBe("done");
  });

  it("refuses at the daily cap and changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T03:00:00Z"));
    const id = await newConversation();
    await send(id);
    store.messages[1]!.status = "done";
    const before = store.messages[1]!.id;
    queue.enqueue.mockClear();
    state.spend = [
      { userId: QA, at: new Date("2026-11-16T01:00:00Z"), costUsd: 1.5 },
    ];
    const res = await post("/retry-answer", { conversationId: id });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: "assistant.daily_cap_reached",
    });
    expect(store.messages[1]).toMatchObject({ id: before, status: "done" });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [
      "environment",
      { environmentId: null, environmentName: "Dev 1", projectId: null },
      "assistant.environment_gone",
    ],
    [
      "project",
      { projectId: null },
      "assistant.context_gone",
    ],
  ])(
    "refuses when the question's pinned %s was deleted and keeps the answer",
    async (_kind, gone, code) => {
      const id = await newConversation();
      await send(id);
      store.messages[1]!.status = "done";
      store.messages[1]!.content = "A good answer";
      Object.assign(store.messages[0]!, gone);
      queue.enqueue.mockClear();
      const res = await post("/retry-answer", { conversationId: id });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code });
      expect(store.messages).toHaveLength(2);
      expect(store.messages[1]).toMatchObject({
        status: "done",
        content: "A good answer",
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
    }
  );

  it("is a 404 and keeps the answer when the user lost the project", async () => {
    const id = await newConversation();
    await send(id);
    store.messages[1]!.status = "done";
    store.messages[1]!.content = "A good answer";
    state.members[PROJECT_KMEM] = [OTHER];
    state.members[PROJECT_HMEM] = [QA];
    queue.enqueue.mockClear();
    const res = await post("/retry-answer", { conversationId: id });
    expect(res.status).toBe(404);
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]).toMatchObject({
      status: "done",
      content: "A good answer",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("fails the new answer when the job cannot be enqueued", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await newConversation();
    await send(id);
    store.messages[1]!.status = "done";
    queue.enqueue.mockRejectedValueOnce(new Error("redis down"));
    const res = await post("/retry-answer", { conversationId: id });
    expect(res.status).toBe(503);
    expect(store.messages[1]).toMatchObject({
      status: "failed",
      errorCode: "assistant.unavailable",
    });
  });
});

describe("send-message", () => {
  it("enqueues exactly one job with jobId = the assistant message id", async () => {
    const id = await newConversation();
    const res = await send(id, "  Bagaimana iuran dihitung?  ", {
      attachments: [
        { issueKey: "KST-12", attachmentId: "10001" },
        { issueKey: "KST-12", attachmentId: "10001" },
        { issueKey: "KST-13", attachmentId: "10002" },
      ],
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
      // Stored as KEY:id pairs, deduplicated.
      attachmentIds: ["KST-12:10001", "KST-13:10002"],
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

  it("refuses at the daily cap: assistant.daily_cap_reached with resetsAt only", async () => {
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
      params: { resetsAt: "2026-11-16T17:00:00.000Z" },
    });
    expect(JSON.stringify(body)).not.toMatch(/capUsd|USD|1\.5/);
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
    const bad = [
      [{ issueKey: "KST-12", attachmentId: "../etc" }],
      [{ issueKey: "kst-12", attachmentId: "10001" }],
      [{ issueKey: "KST-12:1", attachmentId: "10001" }],
      [{ issueKey: "KST-12", attachmentId: "0" }],
      [{ attachmentId: "10001" }],
      [{ issueKey: "KST-12", attachmentId: "10001", extra: 1 }],
    ];
    for (const attachments of bad) {
      expect((await send(id, "q", { attachments })).status).toBe(400);
    }
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      issueKey: "KST-12",
      attachmentId: String(10000 + i),
    }));
    expect((await send(id, "q", { attachments: eleven })).status).toBe(400);
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

describe("rename and delete a chat", () => {
  it("renames the owner's chat, trimmed, without reordering it", async () => {
    const id = await newConversation();
    const before = store.conversations[0]?.updatedAt;
    const res = await post("/rename-conversation", {
      conversationId: id,
      title: "  Iuran   tambahan  ",
    });
    expect(res.status).toBe(200);
    expect(store.conversations[0]).toMatchObject({
      title: "Iuran tambahan",
      updatedAt: before,
    });
  });

  it("refuses an empty title or one longer than 80 characters", async () => {
    const id = await newConversation();
    for (const title of ["", "   ", "a".repeat(81), "é".repeat(81)]) {
      const res = await post("/rename-conversation", {
        conversationId: id,
        title,
      });
      expect(res.status).toBe(400);
    }
    // 80 characters (code points) is the longest.
    const longest = "😀".repeat(80);
    expect(
      (
        await post("/rename-conversation", {
          conversationId: id,
          title: longest,
        })
      ).status
    ).toBe(200);
    expect(store.conversations[0]?.title).toBe(longest);
  });

  it("another user's or an unknown chat is 404 on rename and delete, and stays", async () => {
    as(OTHER);
    const theirs = await newConversation();
    await send(theirs);
    store.files.push({ conversationId: theirs, storageKey: "assistant/x" });
    for (const user of [QA, ADMIN]) {
      as(user, user === ADMIN ? "admin" : "qa");
      for (const id of [theirs, UNKNOWN_ID]) {
        expect(
          (
            await post("/rename-conversation", {
              conversationId: id,
              title: "X",
            })
          ).status
        ).toBe(404);
        expect(
          (await post("/delete-conversation", { conversationId: id })).status
        ).toBe(404);
      }
    }
    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0]?.title).not.toBe("X");
    expect(store.messages).toHaveLength(2);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("stops the owner's pending answer; another user's chat is 404; nothing pending is null", async () => {
    const id = await newConversation();
    const sent = await send(id);
    const answerId = store.messages[1]!.id;
    expect(sent.status).toBe(200);
    const res = await post("/stop-answer", { conversationId: id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: answerId });
    expect(store.messages[1]).toMatchObject({
      status: "failed",
      errorCode: "assistant.stopped",
    });
    const again = await post("/stop-answer", { conversationId: id });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: null });

    as(OTHER);
    const theirs = await newConversation();
    await send(theirs);
    as(QA);
    expect(
      (await post("/stop-answer", { conversationId: theirs })).status
    ).toBe(404);
    expect(
      (await post("/stop-answer", { conversationId: UNKNOWN_ID })).status
    ).toBe(404);
    expect(store.messages[3]?.status).toBe("queued");
  });

  it("deletes the owner's chat with its messages, drafts and stored files", async () => {
    const id = await newConversation();
    const kept = await newConversation();
    await send(id);
    store.messages[1]!.status = "done";
    expect(
      (await post("/generate-draft", { conversationId: id, kind: "jira" }))
        .status
    ).toBe(200);
    store.files.push(
      { conversationId: id, storageKey: "assistant/a" },
      { conversationId: id, storageKey: "assistant/b" },
      { conversationId: kept, storageKey: "assistant/c" }
    );
    const res = await post("/delete-conversation", { conversationId: id });
    expect(res.status).toBe(200);
    expect(store.conversations.map((c) => c.id)).toEqual([kept]);
    expect(store.messages).toEqual([]);
    expect(store.drafts).toEqual([]);
    expect(store.files).toEqual([
      { conversationId: kept, storageKey: "assistant/c" },
    ]);
    expect(storage.deleteObject.mock.calls).toEqual([
      ["assistant/a"],
      ["assistant/b"],
    ]);
    expect((await get(`/get-conversation?conversationId=${id}`)).status).toBe(
      404
    );
  });

  it("keeps the chat deleted when a stored file cannot be removed", async () => {
    const id = await newConversation();
    store.files.push({ conversationId: id, storageKey: "assistant/a" });
    storage.deleteObject.mockRejectedValueOnce(new Error("storage down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/delete-conversation", { conversationId: id });
    expect(res.status).toBe(200);
    expect(store.conversations).toEqual([]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("deletes a chat whose answer is still running", async () => {
    const id = await newConversation();
    await send(id);
    expect(store.messages[1]?.status).toBe("queued");
    expect(
      (await post("/delete-conversation", { conversationId: id })).status
    ).toBe(200);
    expect(store.messages).toEqual([]);
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
    expect(await res.json()).toMatchObject({ enabled: false });
  });

  it("reports a share of the limit, counting 23:59 WIB for that day and resetting at 00:01 WIB", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:59 WIB on 2026-11-16 is 16:59 UTC.
    state.spend = [
      { userId: QA, at: new Date("2026-11-16T16:59:00Z"), costUsd: 0.6 },
      { userId: OTHER, at: new Date("2026-11-16T16:59:00Z"), costUsd: 1 },
    ];
    vi.setSystemTime(new Date("2026-11-16T16:59:30Z"));
    expect(await (await get("/allowance")).json()).toEqual({
      enabled: true,
      usedFraction: 0.4,
      capReached: false,
      resetsAt: "2026-11-16T17:00:00.000Z",
    });

    // 00:01 WIB on 2026-11-17.
    vi.setSystemTime(new Date("2026-11-16T17:01:00Z"));
    expect(await (await get("/allowance")).json()).toEqual({
      enabled: true,
      usedFraction: 0,
      capReached: false,
      resetsAt: "2026-11-17T17:00:00.000Z",
    });
  });

  it("has no dollar amounts, even over the cap, and clamps the fraction to 1", async () => {
    state.spend = [{ userId: QA, at: new Date(), costUsd: 2.25 }];
    const res = await get("/allowance");
    const raw = await res.text();
    expect(raw).not.toMatch(/capUsd|spentUsd|remainingUsd/);
    expect(JSON.parse(raw)).toMatchObject({
      usedFraction: 1,
      capReached: true,
    });
  });

  it("treats a cap of 0 as fully used", async () => {
    state.limits = { enabled: true, hasApiKey: true, dailyCapUsd: 0 };
    state.spend = [];
    expect(await (await get("/allowance")).json()).toMatchObject({
      usedFraction: 1,
      capReached: true,
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
    const res = await get("/list-issue-attachments?issueKey=kmem-12");
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
    const res = await get("/list-issue-attachments?issueKey=HMEM-3");
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
    const res = await get("/list-issue-attachments?issueKey=KMEM-12");
    const text = await res.text();
    expect(text).not.toContain("HTTP 500");
    expect(JSON.parse(text)).toMatchObject({
      attachments: [],
      unavailable: true,
    });
  });
});

describe("drafts", () => {
  async function draftOf(kind: "brd" | "jira" = "jira") {
    const id = await newConversation();
    const res = await post("/generate-draft", { conversationId: id, kind });
    expect(res.status).toBe(200);
    const { draftId } = (await res.json()) as { draftId: string };
    return { conversationId: id, draftId };
  }

  it("generates a draft for the owner with the suggested project and lists it", async () => {
    const { conversationId, draftId } = await draftOf();
    // The suggestion only ever considers projects the caller sees.
    expect(drafting.suggest).toHaveBeenCalledExactlyOnceWith(
      conversationId,
      expect.any(Function)
    );
    const sees = drafting.suggest.mock.calls[0]?.[1] as (id: string) => boolean;
    expect(sees(PROJECT_KMEM)).toBe(true);
    expect(sees(PROJECT_HMEM)).toBe(false);
    expect(drafting.generate).toHaveBeenCalledWith(
      conversationId,
      "jira",
      QA,
      expect.objectContaining({
        runtime: state.runtime,
        projectId: PROJECT_KMEM,
      })
    );
    const body = await (
      await get(`/get-conversation?conversationId=${conversationId}`)
    ).json();
    expect(body).not.toHaveProperty("jiraPushEnabled");
    expect(body.drafts).toEqual([
      expect.objectContaining({
        id: draftId,
        kind: "jira",
        content: JIRA_DRAFT,
        issueId: null,
        jiraKey: null,
        projectId: PROJECT_KMEM,
      }),
    ]);
  });

  it("generates a draft without a project when nothing suggests one", async () => {
    drafting.suggest.mockResolvedValueOnce(null);
    const { conversationId } = await draftOf();
    expect(drafting.generate).toHaveBeenCalledWith(
      conversationId,
      "jira",
      QA,
      expect.objectContaining({ projectId: null })
    );
    const body = await (
      await get(`/get-conversation?conversationId=${conversationId}`)
    ).json();
    expect(body.drafts[0]).toMatchObject({ projectId: null });
  });

  it("shows a draft's project only while the caller can see it", async () => {
    const { conversationId } = await draftOf();
    Object.assign(store.drafts[0] ?? {}, { projectId: PROJECT_HMEM });
    const body = await (
      await get(`/get-conversation?conversationId=${conversationId}`)
    ).json();
    expect(body.drafts[0]).toMatchObject({ projectId: null });
  });

  it("lists the projects a draft can choose, each with its own push switch and issue right", async () => {
    state.jiraPush = { [PROJECT_KMEM]: false, [PROJECT_HMEM]: true };
    as(OTHER);
    const res = await get("/draft-projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: PROJECT_HMEM,
        key: "HMEM",
        name: "Heron Membership",
        jiraPushEnabled: true,
        canCreateIssue: true,
      },
      {
        id: PROJECT_KMEM,
        key: "KMEM",
        name: "Kestrel Membership",
        jiraPushEnabled: false,
        canCreateIssue: true,
      },
    ]);
    // QA sees one project; a viewer may pick it but not create the issue.
    as(QA);
    state.viewers = [QA];
    expect(await (await get("/draft-projects")).json()).toEqual([
      expect.objectContaining({ id: PROJECT_KMEM, canCreateIssue: false }),
    ]);
    // Behind the global gate like every assistant read.
    state.limits = { ...state.limits, enabled: false };
    expect((await get("/draft-projects")).status).toBe(503);
  });

  it("saves the project chosen for a draft only when the caller can see it", async () => {
    state.members[PROJECT_HMEM] = [QA, OTHER];
    const { draftId } = await draftOf();
    const saved = await post("/save-draft", {
      draftId,
      content: JIRA_DRAFT,
      projectId: PROJECT_HMEM,
    });
    expect(saved.status).toBe(200);
    expect(store.drafts[0]?.projectId).toBe(PROJECT_HMEM);

    state.members[PROJECT_HMEM] = [OTHER];
    for (const projectId of [PROJECT_HMEM, UNKNOWN_ID]) {
      const res = await post("/save-draft", {
        draftId,
        content: { ...JIRA_DRAFT, summary: "Diubah" },
        projectId,
      });
      expect(res.status).toBe(404);
    }
    // Nothing of the refused saves was stored.
    expect(store.drafts[0]).toMatchObject({
      projectId: PROJECT_HMEM,
      content: JIRA_DRAFT,
    });
  });

  it("creates the issue in the project chosen for the draft", async () => {
    state.members[PROJECT_HMEM] = [QA, OTHER];
    const { draftId } = await draftOf();
    await post("/save-draft", {
      draftId,
      content: JIRA_DRAFT,
      projectId: PROJECT_HMEM,
    });
    const { requireProjectPermission } = await import("@/lib/authz");
    vi.mocked(requireProjectPermission).mockClear();
    expect((await post("/create-jira-issue", { draftId })).status).toBe(200);
    expect(requireProjectPermission).toHaveBeenCalledWith(
      { projectId: PROJECT_HMEM },
      { issue: ["write"] }
    );
    // The project just authorised: the create refuses a draft moved since.
    expect(drafting.create).toHaveBeenCalledWith(draftId, QA, PROJECT_HMEM);
  });

  it("keeps a draft in the project of a Jira issue it left unlinked", async () => {
    state.members[PROJECT_HMEM] = [QA, OTHER];
    const { draftId } = await draftOf();
    store.unlinked[draftId] = {
      jiraIssueId: "20001",
      jiraKey: "KST-901",
      projectId: PROJECT_KMEM,
    };
    const moved = await post("/save-draft", {
      draftId,
      content: JIRA_DRAFT,
      projectId: PROJECT_HMEM,
    });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({
      code: "assistant.draft_project_locked",
    });
    expect(store.drafts[0]?.projectId).toBe(PROJECT_KMEM);
    // Its own project and a content-only edit still save.
    for (const extra of [{ projectId: PROJECT_KMEM }, {}]) {
      const res = await post("/save-draft", {
        draftId,
        content: { ...JIRA_DRAFT, summary: "Diubah" },
        ...extra,
      });
      expect(res.status).toBe(200);
    }
    // A record from before projects were stored holds the draft's project.
    store.unlinked[draftId] = {
      jiraIssueId: "20001",
      jiraKey: "KST-901",
      projectId: null,
    };
    expect(
      (
        await post("/save-draft", {
          draftId,
          content: JIRA_DRAFT,
          projectId: PROJECT_HMEM,
        })
      ).status
    ).toBe(409);
  });

  it("ignores a project sent with a BRD draft", async () => {
    const { draftId } = await draftOf("brd");
    const res = await post("/save-draft", {
      draftId,
      content: { title: "T2", sections: [] },
      // Not even visible: a BRD draft has no project to choose.
      projectId: PROJECT_HMEM,
    });
    expect(res.status).toBe(200);
    expect(store.drafts[0]).toMatchObject({
      projectId: PROJECT_KMEM,
      content: { title: "T2", sections: [] },
    });
  });

  it("refuses to generate at the daily cap or when off, without a request", async () => {
    const id = await newConversation();
    state.spend = [{ userId: QA, at: new Date(), costUsd: 1.5 }];
    const capped = await post("/generate-draft", {
      conversationId: id,
      kind: "brd",
    });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({
      code: "assistant.daily_cap_reached",
      params: { resetsAt: expect.any(String) },
    });
    state.spend = [];
    state.runtime = null;
    const off = await post("/generate-draft", {
      conversationId: id,
      kind: "brd",
    });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({
      code: "assistant.not_configured",
    });
    expect(drafting.generate).not.toHaveBeenCalled();
  });

  it("maps generation failures to coded refusals", async () => {
    const id = await newConversation();
    const cases = [
      ["assistant.refused", 422],
      ["assistant.nothing_to_draft", 409],
      ["assistant.model_no_drafts", 503],
      ["assistant.failed", 502],
    ] as const;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [code, status] of cases) {
      drafting.generate.mockRejectedValueOnce(new TurnError(code));
      const res = await post("/generate-draft", {
        conversationId: id,
        kind: "jira",
      });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
    log.mockRestore();
  });

  it("classifies a provider error as a draft error and logs only its code", async () => {
    const id = await newConversation();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    drafting.generate.mockRejectedValueOnce(
      new APICallError({
        message: "Bad Request",
        url: "https://llm.example.invalid/v1",
        requestBodyValues: {},
        statusCode: 400,
        responseBody:
          '{"error":{"message":"response_format json_schema is not supported"}}',
      })
    );
    const res = await post("/generate-draft", {
      conversationId: id,
      kind: "brd",
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: "assistant.model_no_drafts" });
    expect(JSON.stringify(body)).not.toContain("response_format");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[assistant] draft not written: assistant.model_no_drafts (AI_APICallError)"
    );
    warn.mockRestore();
  });

  it("another user's draft and conversation are 404 on every draft route", async () => {
    as(OTHER);
    const { conversationId, draftId } = await draftOf();
    as(QA);
    expect(
      (await post("/generate-draft", { conversationId, kind: "jira" })).status
    ).toBe(404);
    expect(
      (await post("/save-draft", { draftId, content: JIRA_DRAFT })).status
    ).toBe(404);
    expect((await post("/create-jira-issue", { draftId })).status).toBe(404);
    expect(
      (await post("/create-jira-issue", { draftId: UNKNOWN_ID })).status
    ).toBe(404);
    expect(drafting.create).not.toHaveBeenCalled();
  });

  it("saves an edit validated against the draft's kind and limits", async () => {
    const { draftId } = await draftOf();
    const edited = { ...JIRA_DRAFT, summary: "Diubah" };
    expect(
      (await post("/save-draft", { draftId, content: edited })).status
    ).toBe(200);
    expect(store.drafts[0]?.content).toEqual(edited);

    for (const content of [
      { ...JIRA_DRAFT, summary: "x".repeat(256) },
      { ...JIRA_DRAFT, description: "x".repeat(32_001) },
      {
        ...JIRA_DRAFT,
        acceptanceCriteria: Array.from({ length: 21 }, () => "a"),
      },
      { title: "BRD shape", sections: [] },
    ]) {
      const res = await post("/save-draft", { draftId, content });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "assistant.invalid_draft",
      });
    }
    expect(store.drafts[0]?.content).toEqual(edited);

    const brd = await draftOf("brd");
    const tooMany = {
      title: "T",
      sections: Array.from({ length: 31 }, () => ({ heading: "H", body: "b" })),
    };
    expect(
      (await post("/save-draft", { draftId: brd.draftId, content: tooMany }))
        .status
    ).toBe(400);
  });

  it("creates the Jira issue once; a second create or a later save is refused", async () => {
    const { conversationId, draftId } = await draftOf();
    const res = await post("/create-jira-issue", { draftId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issueId: "0197f3a0-1b2c-7def-8000-0000000011ee",
      jiraKey: "KST-901",
    });
    expect(drafting.create).toHaveBeenCalledWith(draftId, QA, PROJECT_KMEM);

    const again = await post("/create-jira-issue", { draftId });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: "assistant.draft_already_created",
    });
    const save = await post("/save-draft", { draftId, content: JIRA_DRAFT });
    expect(save.status).toBe(409);
    expect(drafting.create).toHaveBeenCalledTimes(1);

    const body = await (
      await get(`/get-conversation?conversationId=${conversationId}`)
    ).json();
    expect(body.drafts[0]).toMatchObject({ jiraKey: "KST-901" });
  });

  it("needs issue:write: a viewer cannot create the issue", async () => {
    const { draftId } = await draftOf();
    state.viewers = [QA];
    expect((await post("/create-jira-issue", { draftId })).status).toBe(403);
    expect(drafting.create).not.toHaveBeenCalled();
  });

  it("a draft without a project needs one before it becomes a Jira issue", async () => {
    const { draftId } = await draftOf();
    Object.assign(store.drafts[0] ?? {}, { projectId: null });
    const res = await post("/create-jira-issue", { draftId });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "assistant.draft_project_required",
    });
    expect(drafting.create).not.toHaveBeenCalled();
  });

  it("checks issue:write on the draft's project, not the conversation's", async () => {
    const { draftId } = await draftOf();
    Object.assign(store.drafts[0] ?? {}, { projectId: PROJECT_HMEM });
    expect((await post("/create-jira-issue", { draftId })).status).toBe(404);
    expect(drafting.create).not.toHaveBeenCalled();
  });

  it("a BRD draft cannot become a Jira issue", async () => {
    const { draftId } = await draftOf("brd");
    const res = await post("/create-jira-issue", { draftId });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "assistant.invalid_draft" });
  });

  it("words a disabled push, a moved draft and a Jira failure with stable codes", async () => {
    const { draftId } = await draftOf();
    drafting.create.mockRejectedValueOnce(
      new JiraCreateError("assistant.draft_changed")
    );
    const changed = await post("/create-jira-issue", { draftId });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: "assistant.draft_changed",
    });

    drafting.create.mockRejectedValueOnce(
      new JiraCreateError("assistant.jira_push_disabled")
    );
    const disabled = await post("/create-jira-issue", { draftId });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({
      code: "assistant.jira_push_disabled",
    });

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    drafting.create.mockRejectedValueOnce(
      new Error("Jira request failed (400)")
    );
    const failed = await post("/create-jira-issue", { draftId });
    expect(failed.status).toBe(502);
    const body = await failed.json();
    expect(body).toMatchObject({ code: "assistant.jira_create_failed" });
    expect(JSON.stringify(body)).not.toContain("400");
    log.mockRestore();
  });
});
