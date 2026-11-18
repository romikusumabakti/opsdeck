import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantViewer } from "@/lib/assistant/viewer";

type IssueRow = {
  id: string;
  projectId: string;
  jiraKey: string | null;
  jiraIssueId: string | null;
  title: string;
  description: string;
  status: string;
  type: string;
  jiraSyncedAt: Date | null;
};
type CommentRow = {
  issueId: string;
  body: string;
  createdAt: Date;
  author: { name: string } | null;
};
type DocRow = {
  slug: string;
  title: string;
  content: string;
  publishedAt: Date | null;
  createdById: string | null;
  collection: { name: string } | null;
};

const state = vi.hoisted(() => ({
  issues: [] as IssueRow[],
  comments: [] as CommentRow[],
  docs: [] as DocRow[],
  executed: [] as SQL[],
  links: {} as Record<string, { enabled: boolean } | undefined>,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      issues: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: { jiraKey: string; projectId?: { in: string[] } };
          }) =>
            state.issues.find(
              (i) =>
                i.jiraKey === where.jiraKey &&
                (!where.projectId || where.projectId.in.includes(i.projectId))
            )
        ),
      },
      issueComments: {
        findMany: vi.fn(
          async ({
            where,
            limit,
          }: {
            where: { issueId: string };
            limit: number;
          }) =>
            state.comments
              .filter((c) => c.issueId === where.issueId)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .slice(0, limit)
        ),
      },
      knowledgeDocuments: {
        findFirst: vi.fn(async ({ where }: { where: { slug: string } }) =>
          state.docs.find((d) => d.slug === where.slug)
        ),
      },
    },
    execute: vi.fn(async (query: SQL) => {
      state.executed.push(query);
      return [];
    }),
  },
}));

vi.mock("@/lib/jira/sync", () => ({
  resolveLink: vi.fn(async (projectId: string) => {
    const link = state.links[projectId];
    if (!link) return null;
    return {
      link: { projectId, enabled: link.enabled },
      connection: {},
      credentials: {
        baseUrl: "https://acme.atlassian.net",
        flavor: "cloud",
        email: "bot@example.com",
        token: "t",
      },
    };
  }),
}));

const { parseAttachmentRefs } = await import("@/lib/assistant/attachment-refs");
const { REDACTED_LINE } = await import("@/lib/assistant/secret-filter");
const {
  getIssueTool,
  readAttachmentTool,
  readKnowledgeTool,
  searchKnowledgeTool,
  visibleIssueByKey,
} = await import("@/lib/assistant/tools/context");

const KMEM = "00000000-0000-7000-8000-000000000001";
const HMEM = "00000000-0000-7000-8000-000000000002";

const qa: AssistantViewer = {
  userId: "user-qa",
  orgRole: "qa",
  projectIds: [KMEM],
  canManageKnowledge: false,
  scope: {
    userId: "user-qa",
    orgRole: "qa",
    projectRoles: { [KMEM]: "qa" },
    seesAllProjects: false,
  },
};
const admin: AssistantViewer = {
  userId: "user-admin",
  orgRole: "admin",
  projectIds: "all",
  canManageKnowledge: true,
  scope: {
    userId: "user-admin",
    orgRole: "admin",
    projectRoles: { [KMEM]: "engineer", [HMEM]: "engineer" },
    seesAllProjects: true,
  },
};

type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
};
let attachments: Attachment[] = [];
const fetchCalls: string[] = [];

function stubJira() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      fetchCalls.push(url.pathname);
      if (url.pathname.startsWith("/rest/api/3/issue/")) {
        return Response.json({
          id: "1",
          key: "x",
          fields: {
            attachment: attachments.map(({ bytes: _b, ...meta }) => meta),
          },
        });
      }
      const id = url.pathname.split("/").pop();
      const found = attachments.find((a) => a.id === id);
      return found
        ? new Response(new Uint8Array(found.bytes), {
            headers: { "Content-Type": found.mimeType },
          })
        : new Response("nope", { status: 404 });
    })
  );
}

beforeEach(() => {
  state.issues = [
    {
      id: "issue-kmem",
      projectId: KMEM,
      jiraKey: "KST-10",
      jiraIssueId: "5010",
      title: "Iuran calculation",
      description: "Describe the **rule**.",
      status: "open",
      type: "story",
      jiraSyncedAt: new Date(),
    },
    {
      id: "issue-hmem",
      projectId: HMEM,
      jiraKey: "CRM-7",
      jiraIssueId: "6007",
      title: "Other client",
      description: "secret client data",
      status: "open",
      type: "bug",
      jiraSyncedAt: new Date(),
    },
  ];
  state.comments = [
    {
      issueId: "issue-kmem",
      body: "first",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      author: { name: "Widya" },
    },
    {
      issueId: "issue-kmem",
      body: "second",
      createdAt: new Date("2026-11-02T00:00:00Z"),
      author: null,
    },
  ];
  state.docs = [];
  state.executed = [];
  state.links = { [KMEM]: { enabled: true }, [HMEM]: { enabled: true } };
  attachments = [];
  fetchCalls.length = 0;
  stubJira();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PDF = new TextEncoder().encode("%PDF-1.7\n%fake\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("getIssueTool", () => {
  it("rejects issue keys outside the caller's visible projects", async () => {
    const result = await getIssueTool(qa, "CRM-7");
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/not found/);
    expect(fetchCalls).toEqual([]);
    expect(await visibleIssueByKey(qa, "CRM-7")).toBeNull();
  });

  it("treats keys the Panel does not mirror and malformed keys as not found", async () => {
    expect((await getIssueTool(admin, "KST-999")).ok).toBe(false);
    expect((await getIssueTool(admin, "not a key")).ok).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  it("sees nothing with no visible projects", async () => {
    const none = { ...qa, projectIds: [] };
    expect(await visibleIssueByKey(none, "KST-10")).toBeNull();
  });

  it("returns the issue with comments oldest-first and the attachment list", async () => {
    attachments = [
      {
        id: "900",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        size: PDF.byteLength,
        bytes: PDF,
      },
    ];
    const result = await getIssueTool(qa, "kst-10");
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({
      key: "KST-10",
      title: "Iuran calculation",
      status: "open",
      type: "story",
      description: "Describe the **rule**.",
      attachments: [
        {
          id: "900",
          filename: "spec.pdf",
          mime: "application/pdf",
          sizeBytes: PDF.byteLength,
        },
      ],
      attachmentsError: null,
    });
    expect(result.data.comments).toEqual([
      {
        author: "Widya",
        body: "first",
        createdAt: "2026-11-01T00:00:00.000Z",
      },
      {
        author: "Unknown",
        body: "second",
        createdAt: "2026-11-02T00:00:00.000Z",
      },
    ]);
    expect(result.meta.issueKeys).toEqual(["KST-10"]);
    // Looked up by Jira's stable id, not the key.
    expect(fetchCalls).toEqual(["/rest/api/3/issue/5010"]);
  });

  it("redacts credential lines of the description and comments", async () => {
    state.issues[0]!.title =
      "Login fails with token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    state.issues[0]!.description = [
      "Login fails on SIT.",
      "DB_PASSWORD=Sup3rS3cret!",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "-----END OPENSSH PRIVATE KEY-----",
      "See the log.",
    ].join("\n");
    state.comments.push({
      issueId: "issue-kmem",
      body: "Tried again with\npassword: hunter2-Prod!\nstill failing",
      createdAt: new Date("2026-11-03T00:00:00Z"),
      author: { name: "Wulan" },
    });
    const result = await getIssueTool(qa, "KST-10");
    if (!result.ok) throw new Error(result.error);
    expect(result.data.title).toBe(REDACTED_LINE);
    expect(result.data.description).toBe(
      `Login fails on SIT.\n${REDACTED_LINE}\n${REDACTED_LINE}\nSee the log.`
    );
    expect(result.data.comments.at(-1)?.body).toBe(
      `Tried again with\n${REDACTED_LINE}\nstill failing`
    );
    expect(JSON.stringify(result.data)).not.toMatch(
      /Sup3rS3cret|hunter2|ghp_|b3BlbnNzaC|PRIVATE KEY/
    );
    // Title, password line, key block, comment line.
    expect(result.meta).toEqual({ issueKeys: ["KST-10"], withheld: 4 });
  });

  it("still answers from the Panel when the project has no Jira link", async () => {
    state.links = {};
    const result = await getIssueTool(qa, "KST-10");
    if (!result.ok) throw new Error(result.error);
    expect(result.data.attachments).toEqual([]);
    expect(result.data.attachmentsError).toMatch(/no Jira link/);
    expect(fetchCalls).toEqual([]);
  });
});

describe("readAttachmentTool", () => {
  // `ticked` as stored on the message: `KEY:id`.
  const read = (
    viewer: AssistantViewer,
    ticked: string[],
    id: string,
    key = "KST-10"
  ) =>
    readAttachmentTool(viewer, parseAttachmentRefs(ticked), {
      issueKey: key,
      attachmentId: id,
    });

  it("refuses an attachment the user did not tick", async () => {
    attachments = [
      {
        id: "900",
        filename: "a.pdf",
        mimeType: "application/pdf",
        size: 10,
        bytes: PDF,
      },
    ];
    const result = await read(qa, ["KST-10:901"], "900");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/not selected/);
    expect(fetchCalls).toEqual([]);
  });

  it("refuses a ticked id named with another issue than the one ticked", async () => {
    attachments = [
      {
        id: "900",
        filename: "a.pdf",
        mimeType: "application/pdf",
        size: 10,
        bytes: PDF,
      },
    ];
    state.issues.push({
      ...state.issues[0]!,
      id: "issue-11",
      jiraKey: "KST-11",
    });
    const result = await read(qa, ["KST-11:900"], "900", "KST-10");
    expect(!result.ok && result.error).toMatch(/not selected/);
    expect(fetchCalls).toEqual([]);
  });

  it("matches the ticked pair whatever the case of the key", async () => {
    attachments = [
      {
        id: "900",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        size: PDF.byteLength,
        bytes: PDF,
      },
    ];
    const result = await read(qa, ["KST-10:900"], "900", " kst-10 ");
    expect(result.ok).toBe(true);
  });

  it("refuses a PDF over 15 MiB without downloading it", async () => {
    attachments = [
      {
        id: "900",
        filename: "big.pdf",
        mimeType: "application/pdf",
        size: 15 * 1024 * 1024 + 1,
        bytes: PDF,
      },
    ];
    const result = await read(qa, ["KST-10:900"], "900");
    expect(!result.ok && result.error).toMatch(/too large/);
    expect(fetchCalls).toEqual(["/rest/api/3/issue/5010"]);
  });

  it("refuses a ticked id on an issue the viewer cannot see", async () => {
    attachments = [
      {
        id: "900",
        filename: "a.pdf",
        mimeType: "application/pdf",
        size: 10,
        bytes: PDF,
      },
    ];
    const result = await read(qa, ["CRM-7:900"], "900", "CRM-7");
    expect(!result.ok && result.error).toMatch(/not found/);
    expect(fetchCalls).toEqual([]);
  });

  it("refuses a ticked id that is not on the named issue", async () => {
    attachments = [];
    const result = await read(qa, ["KST-10:900"], "900");
    expect(!result.ok && result.error).toMatch(/not found on KST-10/);
    expect(fetchCalls).toEqual(["/rest/api/3/issue/5010"]);
  });

  it("returns a ticked PDF as a document block", async () => {
    attachments = [
      {
        id: "900",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        size: PDF.byteLength,
        bytes: PDF,
      },
    ];
    const result = await read(qa, ["KST-10:900"], "900");
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual({
      kind: "document",
      mediaType: "application/pdf",
      base64: Buffer.from(PDF).toString("base64"),
    });
    expect(result.meta).toEqual({
      issueKeys: ["KST-10"],
      attachmentIds: ["900"],
    });
  });

  it("returns an image with its sniffed media type", async () => {
    attachments = [
      {
        id: "901",
        filename: "shot.jpg",
        mimeType: "image/jpeg",
        size: PNG.byteLength,
        bytes: PNG,
      },
    ];
    const result = await read(qa, ["KST-10:901"], "901");
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({
      kind: "image",
      mediaType: "image/png",
    });
  });

  it("refuses an image over 5 MiB without downloading it", async () => {
    attachments = [
      {
        id: "901",
        filename: "big.png",
        mimeType: "image/png",
        size: 6 * 1024 * 1024,
        bytes: PNG,
      },
    ];
    const result = await read(qa, ["KST-10:901"], "901");
    expect(!result.ok && result.error).toMatch(/too large/);
    expect(fetchCalls).toEqual(["/rest/api/3/issue/5010"]);
  });

  it("refuses docx as not supported in v1", async () => {
    attachments = [
      {
        id: "902",
        filename: "BRD.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 10,
        bytes: new Uint8Array([0x50, 0x4b]),
      },
    ];
    const result = await read(qa, ["KST-10:902"], "902");
    expect(!result.ok && result.error).toMatch(/format not supported in v1/);
  });

  async function workbook(build: (wb: ExcelJS.Workbook) => void) {
    const wb = new ExcelJS.Workbook();
    build(wb);
    return new Uint8Array(await wb.xlsx.writeBuffer());
  }
  const XLSX =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  it("converts xlsx to CSV per sheet with highlights and notes", async () => {
    const bytes = await workbook((wb) => {
      const s = wb.addWorksheet("Fees");
      s.addRow(["Code", "Rate, %"]);
      s.addRow(["A1", 0.5]);
      s.getCell("B2").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFFF00" },
      };
      s.getCell("A2").note = "changed by BA";
      wb.addWorksheet("Notes").addRow(['He said "hi"']);
    });
    attachments = [
      {
        id: "903",
        filename: "fees.xlsx",
        mimeType: XLSX,
        size: bytes.byteLength,
        bytes,
      },
    ];
    const result = await read(qa, ["KST-10:903"], "903");
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual({
      kind: "text",
      text: [
        "# fees.xlsx",
        "",
        "## Sheet: Fees",
        'Code,"Rate, %"',
        "A1 [note: changed by BA],[highlight] 0.5",
        "",
        "## Sheet: Notes",
        '"He said ""hi"""',
      ].join("\n"),
    });
  });

  it("withholds an xlsx that contains credentials", async () => {
    const bytes = await workbook((wb) => {
      wb.addWorksheet("Env").addRow(["db.password=Sup3rS3cret!"]);
    });
    attachments = [
      {
        id: "904",
        filename: "env.xlsx",
        mimeType: XLSX,
        size: bytes.byteLength,
        bytes,
      },
    ];
    const result = await read(qa, ["KST-10:904"], "904");
    expect(!result.ok && result.error).toBe(
      "attachment withheld: contains credentials"
    );
  });
});

describe("knowledge tools", () => {
  const draft: DocRow = {
    slug: "draft-plan",
    title: "Draft plan",
    content: "# not yet",
    publishedAt: null,
    createdById: "someone-else",
    collection: { name: "Ops" },
  };

  it("keeps a draft invisible to a qa viewer", async () => {
    state.docs = [draft];
    const result = await readKnowledgeTool(qa, "draft-plan");
    expect(!result.ok && result.error).toMatch(/not found/);
    const asAdmin = await readKnowledgeTool(admin, "draft-plan");
    expect(asAdmin.ok).toBe(true);
  });

  it("shows a draft to its own author", async () => {
    state.docs = [{ ...draft, createdById: qa.userId }];
    expect((await readKnowledgeTool(qa, "draft-plan")).ok).toBe(true);
  });

  it("caps a published document at 64 KiB", async () => {
    state.docs = [
      { ...draft, publishedAt: new Date(), content: "x".repeat(70 * 1024) },
    ];
    const result = await readKnowledgeTool(qa, "draft-plan");
    if (!result.ok) throw new Error(result.error);
    expect(result.data.markdown.length).toBe(64 * 1024);
    expect(result.data.truncated).toBe(true);
    expect(result.meta.docSlugs).toEqual(["draft-plan"]);
  });

  it("redacts a token line of a document and counts it as withheld", async () => {
    state.docs = [
      {
        ...draft,
        publishedAt: new Date(),
        content:
          "# Deploy\n\nUse the bot token:\nghp_abcdefghijklmnopqrstuvwxyz0123456789AB\nThen run it.",
      },
    ];
    const result = await readKnowledgeTool(qa, "draft-plan");
    if (!result.ok) throw new Error(result.error);
    expect(result.data.markdown).toBe(
      `# Deploy\n\nUse the bot token:\n${REDACTED_LINE}\nThen run it.`
    );
    expect(result.meta).toEqual({ docSlugs: ["draft-plan"], withheld: 1 });
  });

  it("filters drafts out of search for non-managers only", async () => {
    await searchKnowledgeTool(qa, "iuran");
    await searchKnowledgeTool(admin, "iuran");
    const dialect = new PgDialect();
    const [asQa, asAdmin] = state.executed.map((q) => dialect.sqlToQuery(q));
    expect(asQa?.sql).toContain(
      "d.published_at IS NOT NULL OR d.created_by_id ="
    );
    expect(asQa?.params).toContain(qa.userId);
    expect(asAdmin?.sql).not.toContain("published_at IS NOT NULL");
  });
});
