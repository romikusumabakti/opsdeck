import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockedDraft } from "@/lib/assistant/draft-store";

// createJiraIssueFromDraft against a mocked Jira Cloud (fetch) and mocked
// stores: the push switch, the create payload, the local mirror and the link.

const PROJECT = "0197f3a0-1b2c-7def-8000-00000000a001";
const ACTOR = "0197f3a0-1b2c-7def-8000-00000000f001";
const DRAFT = "0197f3a0-1b2c-7def-8000-00000000d001";

const state = vi.hoisted(() => ({
  draft: null as LockedDraft | null,
  link: null as null | {
    enabled: boolean;
    pushEnabled: boolean;
  },
  inserted: [] as Array<{ projectId: string; values: Record<string, unknown> }>,
  linked: [] as Array<{ draftId: string; issueId: string }>,
  activity: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({ tx: true }) },
}));

vi.mock("@/lib/assistant/draft-store", () => ({
  lockDraft: vi.fn(async () => state.draft),
  linkDraftIssue: vi.fn(
    async (_tx: unknown, draftId: string, issueId: string) => {
      state.linked.push({ draftId, issueId });
    }
  ),
  loadCreateContext: vi.fn(async () => ({
    actorName: "Widya",
    projectKey: "KMEM",
  })),
}));

vi.mock("@/lib/issue-number", () => ({
  insertIssueWithNextNumber: vi.fn(
    async (
      _tx: unknown,
      projectId: string,
      values: Record<string, unknown>
    ) => {
      state.inserted.push({ projectId, values });
      return { id: "issue-1", number: 43 };
    }
  ),
}));

vi.mock("@/lib/jira/sync", () => ({
  resolveLink: vi.fn(async () =>
    state.link
      ? {
          link: {
            ...state.link,
            jiraProjectKey: "KST",
            mappingOverrides: null,
          },
          connection: { flavor: "cloud" },
          credentials: {
            baseUrl: "https://acme.atlassian.net",
            flavor: "cloud",
            email: "bot@example.com",
            token: "token",
          },
        }
      : null
  ),
}));

vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (row: Record<string, unknown>) => {
    state.activity.push(row);
  }),
}));

const { createJiraIssueFromDraft, JiraCreateError } = await import(
  "@/lib/jira/create"
);

const ISSUE_TYPES = {
  issueTypes: [
    { id: "10001", name: "Task", subtask: false },
    { id: "10002", name: "Story", subtask: false },
    { id: "10003", name: "Sub-task", subtask: true },
  ],
  maxResults: 50,
  startAt: 0,
  total: 3,
};

const BASE_FIELDS = [
  {
    fieldId: "summary",
    key: "summary",
    name: "Summary",
    required: true,
    schema: { type: "string", system: "summary" },
    operations: ["set"],
  },
  {
    fieldId: "description",
    key: "description",
    name: "Description",
    required: false,
    schema: { type: "string", system: "description" },
    operations: ["set"],
  },
];

type Call = { url: string; method: string; body: unknown };

function mockJira(
  options: { fields?: unknown[]; types?: unknown; getIssueFails?: boolean } = {}
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      calls.push({
        url: url.pathname,
        method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const path = url.pathname;
      if (path === "/rest/api/3/issue/createmeta/KST/issuetypes") {
        return Response.json(options.types ?? ISSUE_TYPES);
      }
      if (path.startsWith("/rest/api/3/issue/createmeta/KST/issuetypes/")) {
        return Response.json({ fields: options.fields ?? BASE_FIELDS });
      }
      if (path === "/rest/api/3/issue" && method === "POST") {
        return Response.json(
          { id: "20001", key: "KST-901", self: "x" },
          { status: 201 }
        );
      }
      if (path === "/rest/api/3/issue/20001") {
        if (options.getIssueFails) return new Response("nope", { status: 404 });
        return Response.json({
          id: "20001",
          key: "KST-901",
          fields: { updated: "2026-11-16T23:30:00.000+0700" },
        });
      }
      return new Response("unexpected", { status: 500 });
    })
  );
  return calls;
}

function jiraDraft(content: Record<string, unknown> = {}): LockedDraft {
  return {
    id: DRAFT,
    kind: "jira",
    projectId: PROJECT,
    issueId: null,
    content: {
      summary: "Iuran tambahan dibulatkan ke atas",
      issueType: "Story",
      description: "Saat ini dibulatkan ke bawah (IuranService.java:42).",
      acceptanceCriteria: [
        "Dibulatkan ke atas",
        "Perlu konfirmasi BA: iuran awal",
      ],
      ...content,
    },
  };
}

/** The `fields` of the create request (the third Jira call). */
function postedFields(calls: Call[]): Record<string, unknown> {
  const body = calls[2]?.body as
    | { fields?: Record<string, unknown> }
    | undefined;
  return body?.fields ?? {};
}

/** All text of an ADF document, in order. */
function adfText(node: unknown): string {
  const n = node as { text?: string; content?: unknown[] };
  return (n.text ?? "") + (n.content ?? []).map(adfText).join("\n");
}

beforeEach(() => {
  state.draft = jiraDraft();
  state.link = { enabled: true, pushEnabled: true };
  state.inserted = [];
  state.linked = [];
  state.activity = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createJiraIssueFromDraft guards", () => {
  it("push disabled: assistant.jira_push_disabled and no HTTP call", async () => {
    const calls = mockJira();
    for (const link of [
      { enabled: true, pushEnabled: false },
      { enabled: false, pushEnabled: true },
      null,
    ]) {
      state.link = link;
      const error = await createJiraIssueFromDraft(DRAFT, ACTOR).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(JiraCreateError);
      expect(error).toMatchObject({ code: "assistant.jira_push_disabled" });
    }
    expect(calls).toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it("refuses a second create for a draft that already has an issue", async () => {
    const calls = mockJira();
    state.draft = { ...jiraDraft(), issueId: "issue-0" };
    await expect(createJiraIssueFromDraft(DRAFT, ACTOR)).rejects.toMatchObject({
      code: "assistant.draft_already_created",
    });
    expect(calls).toEqual([]);
  });

  it("refuses a BRD draft or invalid content as assistant.invalid_draft", async () => {
    const calls = mockJira();
    state.draft = { ...jiraDraft(), kind: "brd" };
    await expect(createJiraIssueFromDraft(DRAFT, ACTOR)).rejects.toMatchObject({
      code: "assistant.invalid_draft",
    });
    state.draft = jiraDraft({ summary: "" });
    await expect(createJiraIssueFromDraft(DRAFT, ACTOR)).rejects.toMatchObject({
      code: "assistant.invalid_draft",
    });
    expect(calls).toEqual([]);
  });
});

describe("createJiraIssueFromDraft", () => {
  it("posts the draft, inserts the local issue with its Jira key and links the draft", async () => {
    const calls = mockJira();
    const result = await createJiraIssueFromDraft(DRAFT, ACTOR);
    expect(result).toEqual({ issueId: "issue-1", jiraKey: "KST-901" });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /rest/api/3/issue/createmeta/KST/issuetypes",
      "GET /rest/api/3/issue/createmeta/KST/issuetypes/10002",
      "POST /rest/api/3/issue",
      "GET /rest/api/3/issue/20001",
    ]);
    const fields = postedFields(calls);
    expect(fields.project).toEqual({ key: "KST" });
    expect(fields.issuetype).toEqual({ id: "10002" });
    expect(fields.summary).toBe("Iuran tambahan dibulatkan ke atas");
    const description = fields.description as { type: string; version: number };
    expect(description).toMatchObject({ type: "doc", version: 1 });
    const words = adfText(description);
    expect(words).toContain("Written by Widya via Menara");
    expect(words).toContain("IuranService.java:42");
    expect(words).toContain("Acceptance Criteria");
    expect(words).toContain("Dibulatkan ke atas");
    expect(JSON.stringify(description)).toContain('"bulletList"');

    expect(state.inserted).toHaveLength(1);
    const local = state.inserted[0];
    expect(local?.projectId).toBe(PROJECT);
    expect(local?.values).toMatchObject({
      title: "Iuran tambahan dibulatkan ke atas",
      type: "story",
      createdById: ACTOR,
      jiraIssueId: "20001",
      jiraKey: "KST-901",
      jiraUpdatedAt: new Date("2026-11-16T16:30:00.000Z"),
    });
    // The local copy names no service account: no attribution line.
    expect(local?.values.description).not.toContain("Written by");
    expect(local?.values.description).toContain("- Dibulatkan ke atas");

    expect(state.linked).toEqual([{ draftId: DRAFT, issueId: "issue-1" }]);
    expect(state.activity).toEqual([
      {
        actorId: ACTOR,
        action: "issue.created_from_assistant",
        entityType: "issue",
        entityId: "issue-1",
        data: { key: "KMEM-43", jiraKey: "KST-901" },
      },
    ]);
  });

  it("fills an Acceptance Criteria field when create-meta offers one", async () => {
    const calls = mockJira({
      fields: [
        ...BASE_FIELDS,
        {
          fieldId: "customfield_10050",
          key: "customfield_10050",
          name: "Acceptance Criteria",
          required: false,
          schema: {
            type: "string",
            custom:
              "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
            customId: 10050,
          },
          operations: ["set"],
        },
      ],
    });
    await createJiraIssueFromDraft(DRAFT, ACTOR);
    const fields = postedFields(calls);
    const criteria = fields.customfield_10050;
    expect(criteria).toMatchObject({ type: "doc" });
    expect(adfText(criteria)).toContain("Perlu konfirmasi BA: iuran awal");
    expect(adfText(fields.description)).not.toContain("Acceptance Criteria");
  });

  it("falls back to Task when the draft's issue type is not offered", async () => {
    const calls = mockJira({
      types: {
        issueTypes: [
          { id: "10001", name: "Task" },
          { id: "10009", name: "Epic" },
        ],
      },
    });
    state.draft = jiraDraft({ issueType: "Bug" });
    await createJiraIssueFromDraft(DRAFT, ACTOR);
    expect(calls[1]?.url).toBe(
      "/rest/api/3/issue/createmeta/KST/issuetypes/10001"
    );
    expect(postedFields(calls).issuetype).toEqual({ id: "10001" });
    expect(state.inserted[0]?.values.type).toBe("task");
  });

  it("uses now as jiraUpdatedAt when the created issue cannot be read back", async () => {
    mockJira({ getIssueFails: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = Date.now();
    await createJiraIssueFromDraft(DRAFT, ACTOR);
    const at =
      (
        state.inserted[0]?.values.jiraUpdatedAt as Date | undefined
      )?.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(state.linked).toHaveLength(1);
    warn.mockRestore();
  });
});
