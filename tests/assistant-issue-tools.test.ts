import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_LINE } from "@/lib/assistant/secret-filter";
import { executeTool, type ToolContext } from "@/lib/assistant/tool-defs";
import {
  createDataTurn,
  DATA_INPUTS,
  type DataCores,
} from "@/lib/assistant/tools/data";
import {
  type DataContext,
  personMatchesQuery,
  unknownProjectError,
} from "@/lib/assistant/tools/data-shared";
import {
  getIssueTool,
  type ListIssuesInput,
  listIssuesTool,
  resolveDateBound,
} from "@/lib/assistant/tools/issues";
import type { AssistantViewer, ProjectEntry } from "@/lib/assistant/viewer";
import type { EnvironmentListItem } from "@/lib/db/schema";
import { APP_TIMEZONE } from "@/lib/timezone";

const jira = vi.hoisted(() => ({
  visible: vi.fn(),
  attachments: vi.fn(),
}));
vi.mock("@/lib/assistant/tools/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/tools/context")>()),
  visibleIssueByKey: jira.visible,
  listIssueAttachments: jira.attachments,
}));
vi.mock("@/lib/jira/sync", () => ({ resolveLink: vi.fn(async () => null) }));

const ACME_ID = "01900000-0000-7000-8000-000000000001";
const BETA_ID = "01900000-0000-7000-8000-000000000002";
const ENV_ID = "01900000-0000-7000-8000-000000001001";
const WULAN_ID = "01900000-0000-7000-8000-00000000a001";
const LABEL_ID = "01900000-0000-7000-8000-00000000b001";

const viewer: AssistantViewer = {
  userId: "u1",
  orgRole: "engineer",
  projectIds: [ACME_ID, BETA_ID],
  canManageKnowledge: false,
  scope: {
    userId: "u1",
    orgRole: "engineer",
    projectRoles: { [ACME_ID]: "engineer", [BETA_ID]: "engineer" },
    seesAllProjects: false,
  },
};
const PROJECTS: ProjectEntry[] = [
  { id: ACME_ID, key: "ACME", name: "Acme", group: null, description: null },
  { id: BETA_ID, key: "BETA", name: "Beta", group: null, description: null },
];
const person = (id: string, name: string, email: string) => ({
  id,
  name,
  preferredName: null,
  email,
  title: null,
});
const PEOPLE = [
  person(WULAN_ID, "Wulan Tan", "wulan@example.invalid"),
  person("p-andi-1", "Andi Pratama", "andi.p@example.invalid"),
  person("p-andi-2", "Andika Putra", "andika@example.invalid"),
];

type Fakes = { [K in keyof DataCores]: ReturnType<typeof vi.fn> };
const issueRow = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  number: 12,
  jiraKey: null,
  title: "Iuran report empty",
  status: "open",
  type: "bug",
  priority: "high",
  assignee: { id: "u2", name: "Sari", image: null },
  environment: null,
  createdAt: new Date("2026-11-09T00:00:00Z"),
  updatedAt: new Date("2026-11-10T00:00:00Z"),
  project: { id: ACME_ID, name: "Acme", key: "ACME" },
  ...over,
});

function fakeCores(): Fakes {
  return {
    listEnvironments: vi.fn(async () => [
      {
        id: ENV_ID,
        projectId: ACME_ID,
        key: "ACME",
        slug: "uat",
        name: "UAT",
      } as EnvironmentListItem,
    ]),
    listIssues: vi.fn(async () => ({ rows: [], total: 0 })),
    getIssueDetail: vi.fn(async () => null),
    listPeople: vi.fn(async () => PEOPLE),
    listLabels: vi.fn(async () => [{ id: LABEL_ID, name: "Bug" }]),
    resolveEnvironmentSlug: vi.fn(async () => null),
  } as unknown as Fakes;
}

function contextFor(cores: Fakes, timeZone?: string): DataContext {
  return {
    viewer,
    mode: "auto",
    data: createDataTurn(viewer, {
      projects: async () => PROJECTS,
      cores: cores as unknown as DataCores,
      timeZone,
    }),
  };
}

const NO_FILTERS: ListIssuesInput = {
  query: null,
  project: null,
  status: null,
  type: null,
  priority: null,
  assignee: null,
  reporter: null,
  labels: null,
  environment: null,
  created_from: null,
  created_to: null,
  updated_from: null,
  updated_to: null,
  sort: null,
  order: null,
  limit: null,
  offset: null,
};

beforeEach(() => {
  jira.visible.mockReset().mockResolvedValue(null);
  jira.attachments
    .mockReset()
    .mockResolvedValue({ attachments: [], error: null });
});

describe("list_issues", () => {
  it("an empty query lists issues", async () => {
    const cores = fakeCores();
    cores.listIssues.mockResolvedValue({ rows: [issueRow()], total: 1 });
    const result = await listIssuesTool(contextFor(cores), NO_FILTERS);
    expect(cores.listIssues).toHaveBeenCalledWith(viewer.scope, {
      status: "all",
      sort: "updatedAt",
      desc: true,
      limit: 20,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        total: 1,
        issues: [
          {
            key: "ACME-12",
            title: "Iuran report empty",
            status: "open",
            type: "bug",
            priority: "high",
            assignee: "Sari",
            createdAt: "2026-11-09T00:00:00Z",
            updatedAt: "2026-11-10T00:00:00Z",
          },
        ],
      },
      meta: { issueKeys: ["ACME-12"] },
    });
  });

  it("shows the Jira key of a mirrored issue and redacts titles", async () => {
    const cores = fakeCores();
    cores.listIssues.mockResolvedValue({
      rows: [issueRow({ jiraKey: "TKT-7", title: "password=hunter2" })],
      total: 1,
    });
    const result = await listIssuesTool(contextFor(cores), NO_FILTERS);
    expect(result).toMatchObject({
      ok: true,
      data: {
        issues: [{ key: "ACME-12", jiraKey: "TKT-7", title: REDACTED_LINE }],
      },
      meta: { withheld: 1 },
    });
  });

  it.each([
    [
      "status",
      { status: ["open", "in_progress"] },
      { statuses: ["open", "in_progress"] },
    ],
    ["type", { type: ["bug"] }, { types: ["bug"] }],
    ["priority", { priority: ["urgent"] }, { priorities: ["urgent"] }],
    ["assignee me", { assignee: "me" }, { assigneeId: "u1" }],
    ["assignee unassigned", { assignee: "unassigned" }, { unassigned: true }],
    ["assignee by name", { assignee: "Wulan" }, { assigneeId: WULAN_ID }],
    ["reporter me", { reporter: "me" }, { createdById: "u1" }],
    ["labels", { labels: ["bug"] }, { labelIds: [LABEL_ID] }],
    ["environment", { environment: "ACME/uat" }, { environmentId: ENV_ID }],
    [
      "sort",
      { sort: "created", order: "asc" },
      { sort: "createdAt", desc: false },
    ],
    ["offset", { offset: 40 }, { offset: 40 }],
    ["text", { query: " iuran " }, { q: "iuran" }],
  ] as const)(
    "maps each filter onto IssueQuery: %s",
    async (_name, input, expected) => {
      const cores = fakeCores();
      const result = await listIssuesTool(contextFor(cores), {
        ...NO_FILTERS,
        ...input,
      } as never);
      expect(result.ok).toBe(true);
      expect(cores.listIssues).toHaveBeenCalledWith(
        viewer.scope,
        expect.objectContaining(expected)
      );
    }
  );

  it("a bare date covers the user's local day", async () => {
    const cores = fakeCores();
    await listIssuesTool(contextFor(cores, "Asia/Jakarta"), {
      ...NO_FILTERS,
      updated_from: "2026-11-20",
      updated_to: "2026-11-20",
    });
    expect(cores.listIssues).toHaveBeenCalledWith(
      viewer.scope,
      expect.objectContaining({
        updatedFrom: new Date("2026-11-19T17:00:00Z"),
        updatedTo: new Date("2026-11-20T17:00:00Z"),
      })
    );
  });

  it("falls back to APP_TIMEZONE when the turn has none", () => {
    expect(contextFor(fakeCores()).data.timeZone).toBe(APP_TIMEZONE);
  });

  it("refuses a malformed date", async () => {
    const cores = fakeCores();
    expect(
      await listIssuesTool(contextFor(cores), {
        ...NO_FILTERS,
        created_from: "20/11/2026",
      })
    ).toEqual({
      ok: false,
      error: "Use YYYY-MM-DD or an ISO datetime with an offset.",
      meta: {},
    });
    expect(cores.listIssues).not.toHaveBeenCalled();
  });

  it("caps limit at 50 and reports total", async () => {
    const cores = fakeCores();
    cores.listIssues.mockResolvedValue({ rows: [], total: 134 });
    const result = await listIssuesTool(contextFor(cores), {
      ...NO_FILTERS,
      limit: 500,
    });
    expect(cores.listIssues).toHaveBeenCalledWith(
      viewer.scope,
      expect.objectContaining({ limit: 50 })
    );
    expect(result.ok && result.data.total).toBe(134);
  });

  it("scoping: passes the viewer's scope and refuses an invisible project", async () => {
    const cores = fakeCores();
    expect(
      await listIssuesTool(contextFor(cores), {
        ...NO_FILTERS,
        project: "HIDDEN",
      })
    ).toMatchObject({
      ok: false,
      error: unknownProjectError("HIDDEN", "auto"),
    });
    expect(cores.listIssues).not.toHaveBeenCalled();
  });

  it("an ambiguous person lists candidates", async () => {
    const result = await listIssuesTool(contextFor(fakeCores()), {
      ...NO_FILTERS,
      assignee: "Andi",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("Andi Pratama");
    expect(!result.ok && result.error).toContain("Andika Putra");
  });

  it("takes no milestone filter (milestones were removed)", () => {
    expect(Object.keys(DATA_INPUTS.list_issues.shape)).not.toContain(
      "milestone"
    );
  });

  it("names what it could not resolve", async () => {
    const ctx = contextFor(fakeCores());
    const fails = async (over: Partial<ListIssuesInput>) => {
      const r = await listIssuesTool(ctx, { ...NO_FILTERS, ...over });
      return !r.ok && r.error;
    };
    expect(await fails({ reporter: "Nobody" })).toBe(
      'No person matches "Nobody".'
    );
    expect(await fails({ labels: ["Nope"] })).toBe('No label named "Nope".');
    expect(await fails({ environment: "ACME/none" })).toContain(
      "Unknown environment ACME/none"
    );
  });

  it("validates input through executeTool", async () => {
    const cores = fakeCores();
    const ctx = {
      ...contextFor(cores),
      attachments: [],
      uploads: [],
      nativeFiles: true,
      snapshotsFor: async () => ({ error: "unknown_project" }) as const,
      listProjects: async () => [],
    } as unknown as ToolContext;
    expect(
      (await executeTool("list_issues", { ...NO_FILTERS, status: ["x"] }, ctx))
        .ok
    ).toBe(false);
    expect(
      (await executeTool("list_issues", { ...NO_FILTERS, limit: 5 }, ctx)).ok
    ).toBe(true);
  });
});

describe("resolveDateBound", () => {
  it("handles bare days, instants and junk", () => {
    expect(resolveDateBound("2026-11-20", "from", "Asia/Jakarta")).toEqual(
      new Date("2026-11-19T17:00:00Z")
    );
    expect(resolveDateBound("2026-12-31", "to", "UTC")).toEqual(
      new Date("2027-01-01T00:00:00Z")
    );
    expect(resolveDateBound("2026-11-20T10:00:00+07:00", "to", "UTC")).toEqual(
      new Date("2026-11-20T03:00:00Z")
    );
    for (const bad of ["20/11/2026", "2026-02-31", "2026-11-20T10:00", "now"]) {
      expect(resolveDateBound(bad, "from", "UTC"), bad).toBeNull();
    }
  });
});

describe("personMatchesQuery", () => {
  it("ignores case and accents, and an empty query matches everyone", () => {
    const p = {
      name: "José Álvaro",
      preferredName: null,
      email: "j@example.invalid",
      title: null,
    };
    expect(personMatchesQuery(p, "jose alv")).toBe(true);
    expect(personMatchesQuery(p, "J@EXAMPLE")).toBe(true);
    expect(personMatchesQuery(p, "")).toBe(true);
    expect(personMatchesQuery(p, "carlos")).toBe(false);
  });
});

describe("get_issue", () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    id: "row-45",
    number: 45,
    jiraKey: "TKT-7",
    title: "Login fails",
    status: "open",
    type: "bug",
    priority: "medium",
    estimate: null,
    description: "Steps:\npassword=hunter2\nthen it fails",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-02T00:00:00Z"),
    project: { id: BETA_ID, name: "Beta", key: "BETA" },
    environment: null,
    assignee: null,
    createdBy: { id: "u3", name: "Wati", image: null },
    labels: [{ id: "l1", name: "auth", color: "red" }],
    parent: null,
    children: [],
    comments: [],
    ...over,
  });
  const mirrored = (over: Record<string, unknown> = {}) => ({
    issue: { id: "row-45", projectId: BETA_ID, number: 45, jiraKey: "TKT-7" },
    link: null,
    ...over,
  });

  it("resolves a Menara key and a Jira key", async () => {
    const cores = fakeCores();
    cores.getIssueDetail.mockImplementation(
      async (_scope: unknown, key: string, number: number) =>
        key === "BETA" && number === 45 ? detail() : null
    );
    const ctx = contextFor(cores);
    jira.attachments.mockResolvedValue({
      attachments: [
        { id: "900", filename: "a.pdf", mime: "application/pdf", sizeBytes: 3 },
      ],
      error: null,
    });
    jira.visible.mockImplementation(async (_v: unknown, key: string) =>
      key === "TKT-7" ? mirrored() : null
    );

    const byMenara = await getIssueTool(ctx, " beta-45 ", null);
    expect(cores.getIssueDetail).toHaveBeenCalledWith(viewer.scope, "BETA", 45);
    expect(byMenara).toMatchObject({
      ok: true,
      data: {
        key: "BETA-45",
        jiraKey: "TKT-7",
        project: "BETA",
        labels: ["auth"],
        description: `Steps:\n${REDACTED_LINE}\nthen it fails`,
        attachments: [{ id: "900" }],
      },
      meta: { project: "BETA", issueKeys: ["BETA-45"], withheld: 1 },
    });
    expect(byMenara.ok && "otherMatch" in byMenara.data).toBe(false);

    const byJira = await getIssueTool(ctx, "TKT-7", null);
    expect(byJira).toMatchObject({
      ok: true,
      data: { key: "BETA-45", jiraKey: "TKT-7" },
    });
    // Resolved through the visible Jira row's project and number.
    expect(cores.getIssueDetail).toHaveBeenLastCalledWith(
      viewer.scope,
      "BETA",
      45
    );
  });

  it("a Menara-only issue has no attachments", async () => {
    const cores = fakeCores();
    cores.getIssueDetail.mockResolvedValue(detail({ jiraKey: null }));
    const result = await getIssueTool(contextFor(cores), "BETA-45", null);
    expect(result.ok && "attachments" in result.data).toBe(false);
    expect(jira.attachments).not.toHaveBeenCalled();
  });

  it("reports a colliding key's other match", async () => {
    const cores = fakeCores();
    cores.getIssueDetail.mockImplementation(
      async (_scope: unknown, key: string, number: number) =>
        key === "ACME" && number === 1
          ? detail({
              id: "row-a",
              number: 1,
              jiraKey: null,
              project: { id: ACME_ID, name: "Acme", key: "ACME" },
            })
          : key === "BETA" && number === 45
            ? detail({ id: "row-b", jiraKey: "ACME-1" })
            : null
    );
    jira.visible.mockResolvedValue({
      issue: {
        id: "row-b",
        projectId: BETA_ID,
        number: 45,
        jiraKey: "ACME-1",
      },
      link: null,
    });
    const ctx = contextFor(cores);
    const both = await getIssueTool(ctx, "ACME-1", null);
    expect(both).toMatchObject({
      ok: true,
      data: {
        key: "ACME-1",
        otherMatch:
          'Jira issue ACME-1 is Menara issue BETA-45; call get_issue with source "jira" to read it.',
      },
    });
    expect(await getIssueTool(ctx, "ACME-1", "jira")).toMatchObject({
      ok: true,
      data: { key: "BETA-45" },
    });
    expect(await getIssueTool(ctx, "ACME-1", "menara")).toMatchObject({
      ok: true,
      data: { key: "ACME-1" },
    });
  });

  it("an inaccessible project's key is not found", async () => {
    expect(await getIssueTool(contextFor(fakeCores()), "HIDE-1", null)).toEqual(
      { ok: false, error: "Issue HIDE-1 not found.", meta: {} }
    );
    expect(
      await getIssueTool(contextFor(fakeCores()), "not a key", null)
    ).toMatchObject({ ok: false, error: "Issue not a key not found." });
  });
});
