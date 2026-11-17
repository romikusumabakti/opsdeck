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
  jiraPushEnabled: true,
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
  const { titleFrom } =
    await importOriginal<typeof import("@/lib/assistant/conversation-store")>();
  const { messageContextOf } = await import("@/lib/assistant/context");
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
            lastContextLabel: last ? messageContextOf(last).label : null,
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
            jiraKey: d.issueId ? "KST-901" : null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          })),
        jiraPushEnabled: state.jiraPushEnabled,
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

const drafting = vi.hoisted(() => ({
  generate: vi.fn(),
  create: vi.fn(),
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
    content: Record<string, unknown>
  ) => {
    const d = store.drafts.find((x) => x.id === draftId && !x.issueId);
    if (d) d.content = content;
    return !!d;
  },
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
  state.viewers = [];
  state.jiraPushEnabled = true;
  drafting.generate.mockImplementation(
    async (conversationId: string, kind: "brd" | "jira") => {
      const id = `0197f3a0-1b2c-7def-8000-${String(++store.seq).padStart(12, "0")}`;
      store.drafts.push({
        id,
        conversationId,
        projectId: PROJECT_KMEM,
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
    as(QA);
    state.members = {};
    expect((await get("/list-conversations")).status).toBe(403);
    expect((await get(`/get-conversation?conversationId=${id}`)).status).toBe(
      403
    );
    expect(
      (await send(id, "Tanya", { context: { kind: "auto" } })).status
    ).toBe(403);
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
      [hmem, "UAT"],
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
    expect(
      (
        await get(
          `/list-issue-attachments?projectId=${PROJECT_HMEM}&issueKey=HMEM-1`
        )
      ).status
    ).toBe(404);
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
    const res = await get(
      `/list-issue-attachments?projectId=${PROJECT_KMEM}&issueKey=kmem-12`
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
      `/list-issue-attachments?projectId=${PROJECT_KMEM}&issueKey=HMEM-3`
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
      `/list-issue-attachments?projectId=${PROJECT_KMEM}&issueKey=KMEM-12`
    );
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

  it("generates a draft for the owner and lists it with jiraPushEnabled", async () => {
    const { conversationId, draftId } = await draftOf();
    expect(drafting.generate).toHaveBeenCalledWith(
      conversationId,
      "jira",
      QA,
      expect.objectContaining({ runtime: state.runtime })
    );
    const body = await (
      await get(`/get-conversation?conversationId=${conversationId}`)
    ).json();
    expect(body.jiraPushEnabled).toBe(true);
    expect(body.drafts).toEqual([
      expect.objectContaining({
        id: draftId,
        kind: "jira",
        content: JIRA_DRAFT,
        issueId: null,
        jiraKey: null,
      }),
    ]);
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
    expect(drafting.create).toHaveBeenCalledWith(draftId, QA);

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

  it("a draft without a project cannot become a Jira issue yet", async () => {
    const { draftId } = await draftOf();
    Object.assign(store.drafts[0] ?? {}, { projectId: null });
    const res = await post("/create-jira-issue", { draftId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "assistant.jira_push_disabled",
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

  it("words a disabled push and a Jira failure with stable codes", async () => {
    const { draftId } = await draftOf();
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
