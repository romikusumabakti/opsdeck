// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import { locales } from "@/i18n/locales";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  allowedEmailDomain: "example.com",
});

const api = vi.hoisted(() => ({
  createJiraIssue: vi.fn(),
  saveDraft: vi.fn(),
  sendMessage: vi.fn(),
  createConversation: vi.fn(),
  generateDraft: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
}));
const nav = vi.hoisted(() => ({ pathname: "/" }));
// A test's own get-conversation result (e.g. a 404); default: never settles.
const conversationFetch = vi.hoisted(
  () => new Map<string, () => Promise<unknown>>()
);

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/web/api/assistant", () => ({
  getAllowanceQuery: () => ({
    queryKey: ["assistant", "getAllowance"],
    queryFn: () => new Promise(() => {}),
  }),
  getConversationQuery: (id: string) => ({
    queryKey: ["assistant", "getConversation", [id]],
    queryFn: () => conversationFetch.get(id)?.() ?? new Promise(() => {}),
  }),
  listConversationsQuery: () => ({
    queryKey: ["assistant", "listConversations"],
    queryFn: () => new Promise(() => {}),
  }),
  listDraftProjectsQuery: () => ({
    queryKey: ["assistant", "listDraftProjects"],
    queryFn: () => new Promise(() => {}),
  }),
  listIssueAttachmentsQuery: (key: string) => ({
    queryKey: ["assistant", "listIssueAttachments", [key]],
    queryFn: () => new Promise(() => {}),
  }),
  messageStreamUrl: (id: string) => `/api/assistant/stream?messageId=${id}`,
  ...api,
}));
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => nav.pathname,
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The context picker's projects and environments: seeded per test.
vi.mock("@/web/api/project-catalog", () => ({
  listProjectsQuery: () => ({
    queryKey: ["project-catalog", "listProjects", []],
    queryFn: () => new Promise(() => {}),
  }),
}));
vi.mock("@/web/api/environments", () => ({
  listEnvironmentsQuery: () => ({
    queryKey: ["environments", "listEnvironments", []],
    queryFn: () => new Promise(() => {}),
  }),
}));

import type { QuestionContextInput } from "@/lib/assistant/context";
import { ApiError } from "@/web/api/client";
import { AllowanceBadge } from "@/web/components/assistant/allowance-badge";
import { ASSISTANT_COMPOSER_ID } from "@/web/components/assistant/assistant-shortcut";
import { AssistantWorkspace } from "@/web/components/assistant/assistant-workspace";
import { AttachmentPicker } from "@/web/components/assistant/attachment-picker";
import { ChatThread } from "@/web/components/assistant/chat-thread";
import { Composer } from "@/web/components/assistant/composer";
import { DraftPanel } from "@/web/components/assistant/draft-panel";
import { JiraDraftForm } from "@/web/components/assistant/jira-draft-form";
import {
  MessageSources,
  summarizeReads,
} from "@/web/components/assistant/message-sources";
import { MessageView } from "@/web/components/assistant/message-view";

const ENV_ID = "3f0c2a52-2a7e-4d1b-9a43-6f1f6f0f0e01";
const ENV_2 = "3f0c2a52-2a7e-4d1b-9a43-6f1f6f0f0e02";
const ENV_3 = "3f0c2a52-2a7e-4d1b-9a43-6f1f6f0f0e03";
const CONV_ID = "8b9d7a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const AUTO: QuestionContextInput = { kind: "auto" };

/**
 * The caller's visible projects and environments, as the shell loads them:
 * Heron Membership (Dev 1, UAT) and Globex Billing (Staging).
 */
function seedCatalog() {
  queryClient.setQueryData(
    ["project-catalog", "listProjects", []],
    [
      { id: "p1", key: "HMEM", name: "Heron Membership" },
      { id: "p2", key: "GBIL", name: "Globex Billing" },
    ]
  );
  queryClient.setQueryData(
    ["environments", "listEnvironments", []],
    [
      { id: ENV_2, projectId: "p1", name: "Heron Membership UAT", kind: "qa" },
      {
        id: ENV_ID,
        projectId: "p1",
        name: "Heron Membership Dev 1",
        kind: "dev",
      },
      { id: ENV_3, projectId: "p2", name: "Staging", kind: "qa" },
    ]
  );
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// --- a controllable EventSource ---------------------------------------------

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown) {
    this.emitRaw(type, JSON.stringify(data));
  }
  emitRaw(type: string, data: string) {
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

// --- rendering ---------------------------------------------------------------

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  for (const fn of Object.values(api)) fn.mockReset();
  conversationFetch.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="Asia/Jakarta"
          now={new Date("2026-11-16T05:00:00Z")}
        >
          {ui}
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label
  );

// The form's create button and the dialog's confirm button share a label.
const confirmButton = () =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button, [role="alertdialog"] button'
    ),
  ].find((b) => b.textContent?.trim() === messages.assistant.confirmCreate);

const t = messages.assistant;

/**
 * A message's context as the API returns it: none on answers, the project
 * branches of "Heron Membership" without an environment name, else that
 * environment.
 */
function contextOf(
  role: string,
  environmentId: string | null,
  environmentName: string | null,
  deleted = false
) {
  if (role !== "user") return null;
  if (environmentName === null) {
    return {
      kind: "project",
      label: "Heron Membership",
      deleted: false,
      projectId: "p1",
      environmentId: null,
    };
  }
  return {
    kind: "environment",
    label: environmentName,
    deleted,
    projectId: "p1",
    environmentId,
  };
}

// --- tests -------------------------------------------------------------------

describe("daily cap", () => {
  const allowance = {
    enabled: true,
    usedFraction: 1,
    capReached: true,
    // Midnight in Asia/Jakarta.
    resetsAt: "2026-11-16T17:00:00.000Z",
  };

  it("the meter shows the share used and the reset time, without dollars", async () => {
    await render(
      <AllowanceBadge
        allowance={{ ...allowance, usedFraction: 0.4, capReached: false }}
      />
    );
    expect(text()).toContain("40% of today's limit used");
    expect(text()).toMatch(/Resets (12:00|00:00)/);
    expect(text()).not.toMatch(/\$|USD/);
    const bar = container.querySelector("[role=progressbar]");
    expect(bar?.getAttribute("aria-valuenow")).toBe("40");
    expect(
      container.querySelector("[data-slot=progress]")?.className
    ).not.toMatch(/amber|destructive/);
  });

  it("the meter turns amber from 80% used", async () => {
    await render(
      <AllowanceBadge
        allowance={{ ...allowance, usedFraction: 0.85, capReached: false }}
      />
    );
    expect(text()).toContain("85% of today's limit used");
    expect(
      container.querySelector("[data-slot=progress]")?.className
    ).toContain("amber");
  });

  it("at the cap the meter turns destructive and role=status; 100% only then", async () => {
    await render(<AllowanceBadge allowance={allowance} />);
    expect(text()).toContain("100% of today's limit used");
    expect(text()).not.toMatch(/\$|USD/);
    expect(
      container.querySelector("[data-slot=progress]")?.className
    ).toContain("destructive");
    expect(container.querySelector("[role=status]")).not.toBeNull();
  });

  it("rounds the percent down and has no status role below the cap", async () => {
    await render(
      <AllowanceBadge
        allowance={{ ...allowance, usedFraction: 0.9996, capReached: false }}
      />
    );
    expect(text()).toContain("99% of today's limit used");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("the composer explains the limit with the reset time at the cap", async () => {
    await render(
      <Composer
        context={AUTO}
        onContextChange={() => {}}
        disabled
        onSend={vi.fn()}
        focusKey="new"
        capResetsAt={allowance.resetsAt}
      />
    );
    expect(container.querySelector("form, div")?.textContent).toMatch(
      /You've reached today's limit\. It resets at (12:00|00:00)/
    );
    expect(button(t.send)?.disabled).toBe(true);
  });

  it("a refused send words assistant.daily_cap_reached", async () => {
    const onSend = vi.fn().mockRejectedValue(
      new ApiError(429, "server text", "assistant.daily_cap_reached", {
        resetsAt: allowance.resetsAt,
      })
    );
    await render(
      <Composer
        context={AUTO}
        onContextChange={() => {}}
        disabled={false}
        onSend={onSend}
        focusKey="new"
      />
    );
    const box = container.querySelector("textarea");
    if (!box) throw new Error("no textarea");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter?.call(box, "Bagaimana iuran dihitung?");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(t.send)?.click());
    expect(onSend).toHaveBeenCalledWith("Bagaimana iuran dihitung?", []);
    expect(text()).toMatch(
      /reached today's limit\. It resets at (12:00|00:00)/
    );
    expect(text()).not.toMatch(/USD|server text/);
    // Kept so it can be sent again tomorrow.
    expect(box.value).toBe("Bagaimana iuran dihitung?");
  });
});

describe("Create Jira ticket", () => {
  const draft = {
    id: "d1",
    kind: "jira" as const,
    content: {
      summary: "Validasi NIK saat registrasi",
      issueType: "Story",
      description: "Deskripsi",
      acceptanceCriteria: ["NIK 16 digit"],
    },
    issueId: null,
    projectId: "p1" as string | null,
    jiraKey: null,
    issueNumber: null,
    createdAt: "2026-11-16T01:00:00Z",
    updatedAt: "2026-11-16T01:00:00Z",
  };
  // What /draft-projects returns: the caller's visible projects, each with
  // its own Jira write-back switch and issue:write.
  const projects = [
    {
      id: "p1",
      key: "HMEM",
      name: "Heron Membership",
      jiraPushEnabled: true,
      canCreateIssue: true,
    },
    {
      id: "p2",
      key: "KMEM",
      name: "Kestrel Membership",
      jiraPushEnabled: false,
      canCreateIssue: true,
    },
    {
      id: "p3",
      key: "OSP",
      name: "Osprey Portal",
      jiraPushEnabled: true,
      canCreateIssue: false,
    },
  ];
  const renderForm = (
    props: { draft?: typeof draft | Record<string, unknown> } = {}
  ) =>
    render(
      <JiraDraftForm
        draft={(props.draft ?? draft) as never}
        projects={projects}
      />
    );
  const picker = () =>
    container.querySelector<HTMLElement>("#draft-d1-project");
  const pick = async (name: string) => {
    await act(async () => picker()?.click());
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const item = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
    ].find((el) => el.textContent?.includes(name));
    if (!item) throw new Error(`no project item ${name}`);
    await act(async () => item.click());
  };

  it("preselects the draft's project and lists the visible projects", async () => {
    await renderForm();
    expect(picker()?.textContent).toContain("Heron Membership");
    await act(async () => picker()?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const items = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
    ].map((el) => el.textContent);
    expect(items).toEqual([
      "Heron MembershipHMEM",
      "Kestrel MembershipKMEM",
      "Osprey PortalOSP",
    ]);
  });

  it("without a project, Create is disabled with the project hint", async () => {
    await renderForm({ draft: { ...draft, projectId: null } });
    expect(picker()?.textContent).toContain(t.draftProjectPlaceholder);
    expect(button(t.createJira)?.disabled).toBe(true);
    expect(text()).toContain(t.draftProjectRequired);
  });

  it("is disabled with a hint when the project's Jira push is off", async () => {
    await renderForm({ draft: { ...draft, projectId: "p2" } });
    expect(button(t.createJira)?.disabled).toBe(true);
    expect(text()).toContain(t.jiraPushOff);
  });

  it("is disabled with a hint without the right to create issues", async () => {
    await renderForm({ draft: { ...draft, projectId: "p3" } });
    expect(button(t.createJira)?.disabled).toBe(true);
    expect(text()).toContain(t.noIssueWrite);
  });

  it("the push hint follows the picked project", async () => {
    await renderForm();
    expect(text()).not.toContain(t.jiraPushOff);
    await pick("Kestrel Membership");
    expect(picker()?.textContent).toContain("Kestrel Membership");
    expect(text()).toContain(t.jiraPushOff);
    await pick("Heron Membership");
    expect(text()).not.toContain(t.jiraPushOff);
  });

  it("a picked project is an edit, saved with the draft", async () => {
    api.saveDraft.mockResolvedValue({ id: "d1" });
    await renderForm({ draft: { ...draft, projectId: null } });
    await pick("Heron Membership");
    // A new project is an unsaved edit: saved before the issue is created.
    expect(button(t.createJira)?.disabled).toBe(true);
    expect(text()).toContain(t.saveBeforeCreate);
    await act(async () => button(t.saveDraft)?.click());
    expect(api.saveDraft).toHaveBeenCalledWith({
      draftId: "d1",
      content: {
        summary: "Validasi NIK saat registrasi",
        issueType: "Story",
        description: "Deskripsi",
        acceptanceCriteria: ["NIK 16 digit"],
      },
      projectId: "p1",
    });
  });

  it("follows a new saved project while clean, and keeps an unsaved pick", async () => {
    const rerender = (projectId: string) =>
      act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <IntlProvider
              locale="en"
              messages={messages}
              timeZone="Asia/Jakarta"
              now={new Date("2026-11-16T05:00:00Z")}
            >
              <JiraDraftForm
                draft={{ ...draft, projectId } as never}
                projects={projects}
              />
            </IntlProvider>
          </QueryClientProvider>
        )
      );
    await renderForm();
    await rerender("p2");
    expect(picker()?.textContent).toContain("Kestrel Membership");
    await pick("Osprey Portal");
    await rerender("p1");
    expect(picker()?.textContent).toContain("Osprey Portal");
  });

  it("asks for confirmation (project, summary and type) before creating", async () => {
    api.createJiraIssue.mockResolvedValue({ issueId: "i1", jiraKey: "KST-9" });
    await renderForm();
    const create = button(t.createJira);
    expect(create?.disabled).toBe(false);
    await act(async () => create?.click());
    expect(api.createJiraIssue).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(t.confirmCreateDescription);
    expect(dialog?.textContent).toContain("Heron Membership");
    expect(dialog?.textContent).toContain("Validasi NIK saat registrasi");
    expect(dialog?.textContent).toContain("Story");
    await act(async () => confirmButton()?.click());
    expect(api.createJiraIssue).toHaveBeenCalledWith("d1");
  });

  it("a 403 from the server becomes the no-right hint", async () => {
    api.createJiraIssue.mockRejectedValue(new ApiError(403, "Forbidden"));
    await renderForm();
    await act(async () => button(t.createJira)?.click());
    await act(async () => confirmButton()?.click());
    expect(text()).toContain(t.noIssueWrite);
    expect(text()).not.toContain("Forbidden");
    expect(button(t.createJira)?.disabled).toBe(true);
  });

  it("is disabled while the draft has unsaved edits", async () => {
    await renderForm();
    const summary =
      container.querySelector<HTMLInputElement>("#draft-d1-summary");
    if (!summary) throw new Error("no summary");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(summary, "Ringkasan baru");
      summary.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button(t.createJira)?.disabled).toBe(true);
    expect(text()).toContain(t.saveBeforeCreate);
  });

  it("links the created issue to the Panel issue of the draft's project", async () => {
    await renderForm({
      draft: { ...draft, issueId: "i1", jiraKey: "KST-9", issueNumber: 42 },
    });
    expect(text()).toContain("Created as KST-9.");
    expect(
      container.querySelector('a[href="/HMEM/issues/42"]')?.textContent
    ).toContain(t.openPanelIssue);
    expect(button(t.createJira)).toBeUndefined();
  });
});

describe("sources", () => {
  const source = {
    componentKey: "backend",
    repoFullName: "acme/membership",
    ciConnectionId: null,
    ref: "kestrel/development",
  };

  it("marks a never-deployed and an unknown-commit component", async () => {
    await render(
      <MessageSources
        sources={[
          {
            ...source,
            commitSha: "0123456789abcdef",
            deployed: true,
            deployedAt: "2026-11-16T03:00:00Z",
          },
          {
            ...source,
            componentKey: "portal",
            repoFullName: "acme/portal",
            commitSha: null,
            deployed: false,
            deployedAt: null,
          },
          {
            ...source,
            componentKey: "legacy",
            repoFullName: "acme/legacy",
            commitSha: null,
            deployed: true,
            deployedAt: "2026-11-15T03:00:00Z",
          },
        ]}
        toolCalls={[]}
      />
    );
    await act(async () => button(t.sources)?.click());
    expect(text()).toContain("acme/membership @ 0123456");
    expect(text()).toContain(
      "never deployed — using the head of branch kestrel/development"
    );
    expect(text()).toContain(
      "running commit unknown — using the head of branch kestrel/development"
    );
  });

  it("labels a project-branch answer with its branch head, not as never deployed", async () => {
    await render(
      <MessageSources
        sources={[
          {
            ...source,
            commitSha: "0123456789abcdef",
            deployed: false,
            deployedAt: null,
          },
        ]}
        toolCalls={[]}
        projectBranches
      />
    );
    await act(async () => button(t.sources)?.click());
    expect(text()).toContain("acme/membership @ 0123456");
    expect(text()).toContain(
      t.sourceBranchHead.replace("{ref}", "kestrel/development")
    );
    expect(text()).not.toContain("never deployed");
  });

  it("the thread passes each answer the source of its question", async () => {
    const message = (
      id: string,
      role: string,
      environmentId: string | null,
      environmentName: string | null
    ) => ({
      id,
      role,
      content: role === "user" ? "Q" : "A",
      status: "done",
      errorCode: null,
      sources:
        role === "user"
          ? null
          : [{ ...source, commitSha: null, deployed: false, deployedAt: null }],
      attachmentIds: [],
      createdAt: "2026-11-16T01:00:00Z",
      toolCalls: [],
      context: contextOf(role, environmentId, environmentName),
    });
    queryClient.setQueryData(["assistant", "getConversation", ["c1"]], {
      id: "c1",
      title: "Iuran",
      drafts: [],
      messages: [
        message("u1", "user", null, null),
        message("a1", "assistant", null, null),
        message("u2", "user", ENV_ID, "Dev 1"),
        message("a2", "assistant", null, null),
      ],
    });
    await render(<ChatThread conversationId="c1" />);
    const triggers = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === t.sources
    );
    for (const trigger of triggers) await act(async () => trigger.click());
    const all = text();
    expect(all).toContain(
      t.sourceBranchHead.replace("{ref}", "kestrel/development")
    );
    // The environment question keeps the deployment wording.
    expect(all).toContain(
      "never deployed — using the head of branch kestrel/development"
    );
  });

  it("names the project of each source and read of an automatic answer", async () => {
    expect(
      summarizeReads([
        {
          tool: "read_file",
          meta: { project: "KST", ranges: ["backend/a.ts:1-9"] },
        },
        {
          tool: "search_code",
          meta: { project: "OSP", paths: ["backend/a.ts"] },
        },
      ]).files
    ).toEqual(["KST backend/a.ts:1-9", "OSP backend/a.ts"]);
    await render(
      <MessageSources
        sources={[
          {
            ...source,
            commitSha: "0123456789abcdef",
            deployed: false,
            deployedAt: null,
            projectKey: "KST",
            projectName: "Kestrel",
          },
        ]}
        toolCalls={[]}
        projectBranches
      />
    );
    await act(async () => button(t.sources)?.click());
    expect(text()).toContain("KST · acme/membership @ 0123456");
  });

  it("labels an automatic answer's sources as branch heads", async () => {
    const auto = {
      kind: "auto",
      label: null,
      deleted: false,
      projectId: null,
      environmentId: null,
    };
    const base = {
      content: "Q",
      status: "done",
      errorCode: null,
      attachmentIds: [],
      createdAt: "2026-11-16T01:00:00Z",
      toolCalls: [],
    };
    queryClient.setQueryData(["assistant", "getConversation", ["c1"]], {
      id: "c1",
      title: "Iuran",
      drafts: [],
      messages: [
        { ...base, id: "u1", role: "user", sources: null, context: auto },
        {
          ...base,
          id: "a1",
          role: "assistant",
          content: "A",
          context: null,
          sources: [
            {
              ...source,
              commitSha: "0123456789abcdef",
              deployed: false,
              deployedAt: null,
              projectKey: "KST",
              projectName: "Kestrel",
            },
          ],
        },
      ],
    });
    await render(<ChatThread conversationId="c1" />);
    await act(async () => button(t.sources)?.click());
    expect(text()).toContain(
      t.sourceBranchHead.replace("{ref}", "kestrel/development")
    );
    expect(text()).not.toContain("never deployed");
  });

  it("lists what the tools read, with the withheld count", () => {
    expect(
      summarizeReads([
        { tool: "list_files", meta: { withheld: 2 } },
        { tool: "search_code", meta: { paths: ["a.ts", "b.ts"], withheld: 1 } },
        { tool: "read_file", meta: { paths: ["a.ts"], ranges: ["a.ts:1-40"] } },
        { tool: "get_issue", meta: { issueKeys: ["KST-1"] } },
        { tool: "search_docs", meta: { docSlugs: ["iuran"], paths: 3 } },
      ])
    ).toEqual({
      files: ["a.ts:1-40", "b.ts"],
      issueKeys: ["KST-1"],
      docSlugs: ["iuran"],
      withheld: 3,
    });
  });
});

describe("answer stream", () => {
  const conversation = (status: string) => ({
    id: "c1",
    title: "Iuran",
    drafts: [],
    messages: [
      {
        id: "m1",
        role: "user",
        content: "Bagaimana iuran dihitung?",
        status: "done",
        errorCode: null,
        sources: null,
        attachmentIds: [],
        createdAt: "2026-11-16T01:00:00Z",
        toolCalls: [],
      },
      {
        id: "m2",
        role: "assistant",
        content: "",
        status,
        errorCode: null,
        sources: null,
        attachmentIds: [],
        createdAt: "2026-11-16T01:00:01Z",
        toolCalls: [],
      },
    ],
  });
  const key = ["assistant", "getConversation", ["c1"]];

  it("closes the EventSource on a terminal snapshot and refetches", async () => {
    queryClient.setQueryData(key, conversation("queued"));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await render(<ChatThread conversationId="c1" />);
    const [source] = FakeEventSource.instances;
    expect(source?.url).toBe("/api/assistant/stream?messageId=m2");

    await act(async () =>
      source?.emit("snapshot", {
        content: "Iuran dihitung dari **gaji pokok**.",
        status: "streaming",
        errorCode: null,
        toolCalls: [],
      })
    );
    expect(source?.closed).toBe(false);
    expect(container.querySelector("strong")?.textContent).toBe("gaji pokok");

    await act(async () =>
      source?.emit("snapshot", {
        content: "Iuran dihitung dari gaji pokok.",
        status: "done",
        errorCode: null,
        toolCalls: [],
      })
    );
    expect(source?.closed).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    expect(text()).toContain(t.disclaimer);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("closes on a malformed frame and refetches", async () => {
    queryClient.setQueryData(key, conversation("streaming"));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await render(<ChatThread conversationId="c1" />);
    const [source] = FakeEventSource.instances;
    await act(async () => source?.emitRaw("snapshot", "{not json"));
    expect(source?.closed).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
  });

  it("closes on not-found and on unmount", async () => {
    queryClient.setQueryData(key, conversation("streaming"));
    await render(<ChatThread conversationId="c1" />);
    const [first] = FakeEventSource.instances;
    await act(async () => first?.emit("not-found", { id: "m2" }));
    expect(first?.closed).toBe(true);

    act(() => root.unmount());
    queryClient.setQueryData(key, conversation("streaming"));
    await render(<ChatThread conversationId="c1" />);
    const second = FakeEventSource.instances.at(-1);
    expect(second?.closed).toBe(false);
    act(() => root.unmount());
    expect(second?.closed).toBe(true);
    // afterEach unmounts again.
    root = createRoot(container);
  });

  it("opens no stream for a finished answer and words a failure", async () => {
    queryClient.setQueryData(key, {
      ...conversation("failed"),
      messages: conversation("failed").messages.map((m) =>
        m.id === "m2" ? { ...m, errorCode: "assistant.credit_exhausted" } : m
      ),
    });
    await render(<ChatThread conversationId="c1" />);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(text()).toContain(messages.assistantErrors.creditExhausted);
  });

  it("words a turn stopped at the daily cap with the current allowance", async () => {
    queryClient.setQueryData(["assistant", "getAllowance"], {
      enabled: true,
      usedFraction: 1,
      capReached: true,
      resetsAt: "2026-11-16T17:00:00.000Z",
    });
    queryClient.setQueryData(key, {
      ...conversation("failed"),
      messages: conversation("failed").messages.map((m) =>
        m.id === "m2" ? { ...m, errorCode: "assistant.daily_cap_reached" } : m
      ),
    });
    await render(<ChatThread conversationId="c1" />);
    expect(text()).toMatch(
      /reached today's limit\. It resets at (12:00|00:00)/
    );
    expect(text()).not.toContain("USD");
  });

  it("renders no raw HTML from an answer", async () => {
    queryClient.setQueryData(key, {
      ...conversation("done"),
      messages: conversation("done").messages.map((m) =>
        m.id === "m2"
          ? {
              ...m,
              content:
                'Lihat <img src=x onerror="alert(1)"> [docs](https://example.com)',
            }
          : m
      ),
    });
    await render(<ChatThread conversationId="c1" />);
    expect(container.querySelector("img")).toBeNull();
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("never loads a markdown image (no img, no preload)", async () => {
    queryClient.setQueryData(key, {
      ...conversation("done"),
      messages: conversation("done").messages.map((m) =>
        m.id === "m2"
          ? {
              ...m,
              content:
                "Lihat ![x](https://example.com/a.png) dan ![](https://evil.example/p?d=NIK123)",
            }
          : m
      ),
    });
    await render(<ChatThread conversationId="c1" />);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('link[rel="preload"]')).toBeNull();
    expect(document.documentElement.innerHTML).not.toContain(
      "example.com/a.png"
    );
    expect(document.documentElement.innerHTML).not.toContain("NIK123");
    expect(text()).toContain("Lihat x dan");
  });
  // happy-dom does no layout: give the scroller a fixed geometry.
  const scroller = () => {
    const el = container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!el) throw new Error("no scroller");
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      value: 400,
    });
    return el;
  };
  const scrollUp = (el: HTMLElement) =>
    act(async () => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
  const userMessage = (id: string) => ({
    ...conversation("done").messages[0],
    id,
    content: "Lalu bagaimana pajaknya?",
  });

  it("scrolls to the bottom on the caller's own send even when scrolled up", async () => {
    queryClient.setQueryData(key, conversation("done"));
    await render(<ChatThread conversationId="c1" />);
    const el = scroller();
    await scrollUp(el);
    await act(async () => {
      const base = conversation("done");
      queryClient.setQueryData(key, {
        ...base,
        messages: [...base.messages, userMessage("m3")],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.scrollTop).toBe(1000);
  });

  it("does not pull a reader who scrolled up back down on new answer text", async () => {
    queryClient.setQueryData(key, conversation("streaming"));
    await render(<ChatThread conversationId="c1" />);
    const el = scroller();
    await scrollUp(el);
    const [source] = FakeEventSource.instances;
    await act(async () =>
      source?.emit("snapshot", {
        content: "Lebih banyak teks",
        status: "streaming",
        errorCode: null,
        toolCalls: [],
      })
    );
    expect(el.scrollTop).toBe(100);
  });

  it("follows late content growth while at the bottom", async () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    );
    queryClient.setQueryData(key, conversation("done"));
    await render(<ChatThread conversationId="c1" />);
    const el = scroller();
    el.scrollTop = 600;
    await act(async () => el.dispatchEvent(new Event("scroll")));
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: 1500,
    });
    act(() => {
      for (const notify of observers) notify();
    });
    expect(el.scrollTop).toBe(1500);
  });
});

describe("composer attachments", () => {
  it("sends each ticked attachment with its issue key", async () => {
    queryClient.setQueryData(
      ["assistant", "listIssueAttachments", ["KST-12"]],
      {
        key: "KST-12",
        unavailable: false,
        attachments: [
          {
            id: "10001",
            filename: "BRD.pdf",
            mime: "application/pdf",
            sizeBytes: 10,
          },
        ],
      }
    );
    const onSend = vi.fn().mockResolvedValue(undefined);
    await render(
      <Composer
        context={AUTO}
        onContextChange={() => {}}
        disabled={false}
        onSend={onSend}
        focusKey="new"
      />
    );
    await act(async () => button(t.attachments)?.click());
    const input = document.querySelector<HTMLInputElement>(
      "#assistant-issue-key"
    );
    if (!input) throw new Error("no input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "kst-12");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(t.showAttachments)?.click());
    await act(async () =>
      (
        document.querySelector(
          '[role="checkbox"][aria-labelledby="assistant-attachment-10001-label"]'
        ) as HTMLElement | null
      )?.click()
    );
    await act(async () => button("Use 1 attachment")?.click());
    const box = container.querySelector("textarea");
    if (!box) throw new Error("no textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(box, "Apa isi BRD ini?");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(t.send)?.click());
    expect(onSend).toHaveBeenCalledWith("Apa isi BRD ini?", [
      { issueKey: "KST-12", attachmentId: "10001" },
    ]);
  });
});

describe("composer focus and keys", () => {
  const composer = (focusKey: string | null) => (
    <Composer
      context={AUTO}
      onContextChange={() => {}}
      disabled={false}
      onSend={vi.fn().mockResolvedValue(undefined)}
      focusKey={focusKey}
    />
  );
  // Same tree shape as render(), so a re-render keeps the mounted textarea.
  const rerender = (ui: React.ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <IntlProvider
            locale="en"
            messages={messages}
            timeZone="Asia/Jakarta"
            now={new Date("2026-11-16T05:00:00Z")}
          >
            {ui}
          </IntlProvider>
        </QueryClientProvider>
      )
    );

  it("focuses the textarea on render and again when focusKey changes", async () => {
    await render(composer("new"));
    const box = container.querySelector("textarea");
    if (!box) throw new Error("no textarea");
    expect(document.activeElement).toBe(box);
    // The id the Ctrl/Cmd+J shortcut focuses.
    expect(box.id).toBe(ASSISTANT_COMPOSER_ID);
    box.blur();
    expect(document.activeElement).not.toBe(box);
    await rerender(composer("c1"));
    expect(document.activeElement).toBe(box);
  });

  it("Enter sends, Shift+Enter does not, and focus returns after a send", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    await render(
      <Composer
        context={AUTO}
        onContextChange={() => {}}
        disabled={false}
        onSend={onSend}
        focusKey="new"
      />
    );
    const box = container.querySelector("textarea");
    if (!box) throw new Error("no textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(box, "Hello");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      box.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        })
      );
    });
    expect(onSend).not.toHaveBeenCalled();
    box.blur();
    await act(async () => {
      box.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(onSend).toHaveBeenCalledWith("Hello", []);
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
  });
});

describe("draft panel", () => {
  const conversation = {
    id: "c1",
    title: "Iuran",
    drafts: [],
    messages: [
      {
        id: "m2",
        role: "assistant",
        content: "Jawaban",
        status: "done",
        errorCode: null,
        sources: null,
        attachmentIds: [],
        createdAt: "2026-11-16T01:00:01Z",
        toolCalls: [],
      },
    ],
  };
  const key = ["assistant", "getConversation", ["c1"]];

  it("refetches the conversation after a failed generate (the draft may exist) and shows the error", async () => {
    queryClient.setQueryData(key, conversation);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    // A proxy timeout: no problem+json body, so no code.
    api.generateDraft.mockRejectedValue(new ApiError(504, "Gateway Timeout"));
    await render(<DraftPanel conversationId="c1" disabled={false} />);
    await act(async () => button(t.draftBrd)?.click());
    // React Query notifies observers on a zero-delay timer.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.generateDraft).toHaveBeenCalledWith({
      conversationId: "c1",
      kind: "brd",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    expect(text()).toContain(messages.assistantErrors.failed);
    expect(text()).not.toContain("Gateway Timeout");
  });
});

describe("drafts panel in the workspace", () => {
  const draft = (id: string) => ({
    id,
    kind: "brd" as const,
    content: { title: "BRD", sections: [] },
    issueId: null,
    jiraKey: null,
    issueNumber: null,
    createdAt: "2026-11-16T01:00:00Z",
    updatedAt: "2026-11-16T01:00:00Z",
  });
  const conversation = {
    id: "c1",
    title: "Iuran",
    drafts: [] as ReturnType<typeof draft>[],
    messages: [],
  };
  const conversationKey = ["assistant", "getConversation", ["c1"]];
  const panel = () => document.querySelector('section[aria-label^="Drafts"]');
  const toggle = (count: number) =>
    button(t.drafts.replace("{count}", String(count)));

  const renderWorkspace = async () => {
    queryClient.setQueryData(["assistant", "getAllowance"], {
      enabled: true,
      usedFraction: 0,
      capReached: false,
      resetsAt: "2026-11-16T17:00:00.000Z",
    });
    queryClient.setQueryData(
      ["assistant", "listConversations"],
      [{ id: "c1", title: "Iuran", updatedAt: "2026-11-16T01:00:00Z" }]
    );
    queryClient.setQueryData(conversationKey, conversation);
    await render(<AssistantWorkspace />);
  };

  it("has no drafts toggle until a conversation is selected", async () => {
    await renderWorkspace();
    expect(toggle(0)).toBeUndefined();
    expect(panel()).toBeNull();
  });

  it("is closed initially and the Drafts button toggles it", async () => {
    await renderWorkspace();
    const item = [...document.querySelectorAll("nav button")].find((b) =>
      b.textContent?.includes("Iuran")
    ) as HTMLButtonElement | undefined;
    await act(async () => item?.click());
    expect(panel()).toBeNull();
    await act(async () => toggle(0)?.click());
    expect(panel()).not.toBeNull();
    await act(async () => toggle(0)?.click());
    expect(panel()).toBeNull();
  });

  it("opens when the conversation gains a draft", async () => {
    await renderWorkspace();
    const item = [...document.querySelectorAll("nav button")].find((b) =>
      b.textContent?.includes("Iuran")
    ) as HTMLButtonElement | undefined;
    await act(async () => item?.click());
    expect(panel()).toBeNull();
    await act(async () => {
      queryClient.setQueryData(conversationKey, {
        ...conversation,
        drafts: [draft("d1")],
      });
      // React Query notifies observers on a zero-delay timer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(panel()).not.toBeNull();
    expect(toggle(1)).toBeDefined();
  });

  it("titles the panel plain Drafts; only the toggle shows the count", async () => {
    await renderWorkspace();
    const item = [...document.querySelectorAll("nav button")].find((b) =>
      b.textContent?.includes("Iuran")
    ) as HTMLButtonElement | undefined;
    await act(async () => item?.click());
    await act(async () => toggle(0)?.click());
    expect(panel()?.querySelector("h2")?.textContent).toBe(t.draftsTitle);
    expect(t.draftsTitle).toBe("Drafts");
    expect(toggle(0)?.textContent).toContain("(0)");
  });
  it("does not open when switching to a conversation that already has drafts", async () => {
    await renderWorkspace();
    queryClient.setQueryData(
      ["assistant", "listConversations"],
      [
        { id: "c1", title: "Iuran", updatedAt: "2026-11-16T01:00:00Z" },
        { id: "c2", title: "Pajak", updatedAt: "2026-11-16T01:00:00Z" },
      ]
    );
    queryClient.setQueryData(["assistant", "getConversation", ["c2"]], {
      ...conversation,
      id: "c2",
      title: "Pajak",
      drafts: [draft("d1"), draft("d2")],
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const pick = (title: string) =>
      [...document.querySelectorAll("nav button")].find((b) =>
        b.textContent?.includes(title)
      ) as HTMLButtonElement | undefined;
    await act(async () => pick("Iuran")?.click());
    await act(async () => pick("Pajak")?.click());
    expect(toggle(2)).toBeDefined();
    expect(panel()).toBeNull();
  });
});

describe("context picker", () => {
  const userMessage = (id: string, context: unknown) => ({
    id,
    role: "user",
    content: "Q",
    status: "done",
    errorCode: null,
    sources: null,
    attachmentIds: [],
    createdAt: "2026-11-16T01:00:00Z",
    toolCalls: [],
    context,
  });
  const answer = {
    ...userMessage("a1", null),
    role: "assistant",
    content: "Jawaban",
  };
  const chip = () =>
    container.querySelector<HTMLElement>('[data-slot="combobox-trigger"]');
  const items = () =>
    [
      ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
    ].map((el) => el.textContent);
  const item = (label: string) =>
    [
      ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
    ].find((el) => el.textContent === label);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  };

  const renderWorkspace = async (
    props: {
      initialContext?: QuestionContextInput | null;
      conversationId?: string | null;
      onConversationChange?: (id: string | null) => void;
    } = {},
    messagesOfC1: unknown[] = [],
    conversations: unknown[] = [
      {
        id: CONV_ID,
        title: "Iuran",
        updatedAt: "2026-11-16T01:00:00Z",
        lastContextLabel: null,
      },
    ]
  ) => {
    seedCatalog();
    queryClient.setQueryData(["assistant", "getAllowance"], {
      enabled: true,
      usedFraction: 0,
      capReached: false,
      resetsAt: "2026-11-16T17:00:00.000Z",
    });
    queryClient.setQueryData(["assistant", "listConversations"], conversations);
    queryClient.setQueryData(["assistant", "getConversation", [CONV_ID]], {
      id: CONV_ID,
      title: "Iuran",
      drafts: [],
      messages: messagesOfC1,
    });
    await render(<AssistantWorkspace {...props} />);
  };

  const type = async (value: string) => {
    const box = container.querySelector("textarea");
    if (!box) throw new Error("no textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(box, value);
      box.setSelectionRange(value.length, value.length);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return box;
  };
  const typeAndSend = async (question: string) => {
    await type(question);
    await act(async () => button(t.send)?.click());
  };

  it("defaults to Automatic and sends an automatic question", async () => {
    api.createConversation.mockResolvedValue({ id: CONV_ID });
    api.sendMessage.mockResolvedValue({});
    await renderWorkspace();
    expect(chip()?.textContent).toBe(t.contextAuto);
    await typeAndSend("Di mana hitung iuran?");
    expect(api.createConversation).toHaveBeenCalledExactlyOnceWith();
    expect(api.sendMessage).toHaveBeenCalledWith({
      conversationId: CONV_ID,
      text: "Di mana hitung iuran?",
      context: { kind: "auto" },
    });
  });

  it("stays on a conversation opened while the first send was pending", async () => {
    const NEW_ID = "8b9d7a10-1c2d-4e5f-8a9b-0c1d2e3f4a5c";
    let finishSend = () => {};
    api.createConversation.mockResolvedValue({ id: NEW_ID });
    api.sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSend = () => resolve({});
        })
    );
    const onConversationChange = vi.fn();
    await renderWorkspace({ onConversationChange });
    await typeAndSend("Di mana?");
    await settle();
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>("nav button"),
    ].find((b) => b.textContent?.includes("Iuran"));
    await act(async () => row?.click());
    expect(onConversationChange).toHaveBeenLastCalledWith(CONV_ID);
    onConversationChange.mockClear();
    await act(async () => finishSend());
    await settle();
    expect(onConversationChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[aria-current="true"]')?.textContent
    ).toContain("Iuran");
  });

  it("opens a new conversation only once its first question is stored", async () => {
    // A read of the conversation racing its first send came back empty, and
    // nothing read it again: the thread stayed on "Start asking".
    const NEW_ID = "8b9d7a10-1c2d-4e5f-8a9b-0c1d2e3f4a5c";
    let stored = false;
    let finishSend = () => {};
    api.createConversation.mockResolvedValue({ id: NEW_ID });
    api.sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSend = () => {
            stored = true;
            resolve({});
          };
        })
    );
    const reads: boolean[] = [];
    conversationFetch.set(NEW_ID, async () => {
      reads.push(stored);
      return {
        id: NEW_ID,
        title: "",
        drafts: [],
        messages: stored ? [userMessage("u1", null)] : [],
      };
    });
    const onConversationChange = vi.fn();
    await renderWorkspace({ onConversationChange });
    await typeAndSend("Di mana?");
    await settle();
    expect(onConversationChange).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    await act(async () => finishSend());
    await settle();
    expect(onConversationChange).toHaveBeenCalledExactlyOnceWith(NEW_ID);
    expect(reads).toEqual([true]);
  });

  it("a failed first send is retried into the conversation it created", async () => {
    api.createConversation.mockResolvedValue({ id: CONV_ID });
    api.sendMessage.mockRejectedValueOnce(new Error("boom"));
    api.sendMessage.mockResolvedValue({});
    await renderWorkspace();
    await typeAndSend("Di mana?");
    await settle();
    await act(async () => button(t.send)?.click());
    await settle();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: CONV_ID })
    );
  });

  it("starts on the ?project project and the ?env environment", async () => {
    await renderWorkspace({
      initialContext: { kind: "project", projectId: "p1" },
    });
    expect(chip()?.textContent).toBe("Heron Membership");
    act(() => root.unmount());
    container.remove();
    await renderWorkspace({
      initialContext: { kind: "environment", environmentId: ENV_ID },
    });
    expect(chip()?.textContent).toBe("Heron Membership · Dev 1");
  });

  it("a preselected project the caller does not see is Automatic", async () => {
    await renderWorkspace({
      initialContext: { kind: "project", projectId: "gone" },
    });
    expect(chip()?.textContent).toBe(t.contextAuto);
  });

  it("names the context in the chip's label", async () => {
    await renderWorkspace({
      initialContext: { kind: "environment", environmentId: ENV_ID },
    });
    expect(chip()?.getAttribute("aria-label")).toBe(
      t.contextPick.replace("{name}", "Heron Membership · Dev 1")
    );
  });

  it("lists Automatic, then the projects by name, each with its environments in kind order", async () => {
    await renderWorkspace();
    await act(async () => chip()?.click());
    await settle();
    expect(items()).toEqual([
      t.contextAuto,
      "Globex Billing",
      "Staging",
      "Heron Membership",
      "Dev 1",
      "UAT",
    ]);
  });

  it("indents environments under their project", async () => {
    await renderWorkspace();
    await act(async () => chip()?.click());
    await settle();
    const indent = (name: string) => {
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((o) => o.textContent === name);
      if (!option) throw new Error(`no option ${name}`);
      // The indent is a logical margin (ms-*) on the content, so it sits on
      // the start side in RTL (Arabic) too and the item's own padding cannot
      // override it; no physical pl-*/ml-* is involved.
      const content = option.firstElementChild;
      if (!content) throw new Error("no content");
      return [
        option.className.match(/\b(?:pl|ml)-\S+/g) ?? [],
        content.className.split(" ").filter((c) => /^m[se]-/.test(c)),
      ];
    };
    expect(indent("Heron Membership")).toEqual([["pl-2"], []]);
    expect(indent("Dev 1")).toEqual([["pl-2"], ["ms-6"]]);
  });

  it("searches projects and environments together", async () => {
    await renderWorkspace();
    await act(async () => chip()?.click());
    await settle();
    const search = document.querySelector<HTMLInputElement>(
      '[data-slot="combobox-content"] input'
    );
    if (!search) throw new Error("no search");
    const find = async (query: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set?.call(search, query);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
      return items();
    };
    expect(await find("uat")).toEqual(["UAT"]);
    // A project's name finds it and its environments.
    expect(await find("heron")).toEqual(["Heron Membership", "Dev 1", "UAT"]);
  });

  it("sends the environment or project picked in the chip", async () => {
    api.sendMessage.mockResolvedValue({});
    await renderWorkspace({ conversationId: CONV_ID }, [answer]);
    await act(async () => chip()?.click());
    await settle();
    await act(async () => item("UAT")?.click());
    await settle();
    expect(chip()?.textContent).toBe("Heron Membership · UAT");
    await typeAndSend("Bedanya di UAT?");
    expect(api.sendMessage).toHaveBeenLastCalledWith({
      conversationId: CONV_ID,
      text: "Bedanya di UAT?",
      context: { kind: "environment", environmentId: ENV_2 },
    });
    await act(async () => chip()?.click());
    await settle();
    await act(async () => item("Globex Billing")?.click());
    await settle();
    await typeAndSend("Dan di Globex?");
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenLastCalledWith({
      conversationId: CONV_ID,
      text: "Dan di Globex?",
      context: { kind: "project", projectId: "p2" },
    });
  });

  describe("@ mentions", () => {
    const options = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-slot="mention-list"] [role="option"]'
        ),
      ].map((el) => el.textContent);
    const press = async (
      box: HTMLTextAreaElement,
      key: string,
      init: KeyboardEventInit = {}
    ) => {
      const ev = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(async () => {
        box.dispatchEvent(ev);
      });
      await settle();
      return ev;
    };

    it("lists matching projects, then environments, under the box", async () => {
      await renderWorkspace();
      await type("ask @her");
      await settle();
      expect(options()).toEqual([
        "Heron Membership",
        "Heron Membership · Dev 1",
        "Heron Membership · UAT",
      ]);
      // No Automatic entry: that stays on the chip.
      await type("@");
      await settle();
      expect(options()).not.toContain(t.contextAuto);
      expect(options()).toHaveLength(5);
    });

    it("Enter picks the highlighted match: it fills the box and sets the chip", async () => {
      await renderWorkspace();
      const box = await type("@her");
      await settle();
      const ev = await press(box, "Enter");
      expect(ev.defaultPrevented).toBe(true);
      expect(box.value).toBe("@Heron Membership ");
      expect(box.selectionStart).toBe("@Heron Membership ".length);
      expect(chip()?.textContent).toBe("Heron Membership");
      expect(options()).toEqual([]);
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("arrows move the highlight and Tab picks; the last pick wins", async () => {
      api.createConversation.mockResolvedValue({ id: CONV_ID });
      api.sendMessage.mockResolvedValue({});
      await renderWorkspace();
      let box = await type("@gbil");
      await settle();
      await press(box, "Enter");
      expect(chip()?.textContent).toBe("Globex Billing");
      box = await type("@Globex Billing about @her");
      await settle();
      await press(box, "ArrowDown");
      await press(box, "ArrowDown");
      await press(box, "ArrowUp");
      await press(box, "Tab");
      expect(box.value).toBe(
        "@Globex Billing about @Heron Membership · Dev 1 "
      );
      expect(chip()?.textContent).toBe("Heron Membership · Dev 1");
      await press(box, "Enter");
      expect(api.sendMessage).toHaveBeenCalledWith({
        conversationId: CONV_ID,
        text: "@Globex Billing about @Heron Membership · Dev 1",
        context: { kind: "environment", environmentId: ENV_ID },
      });
    });

    it("a click on a match picks it", async () => {
      await renderWorkspace();
      await type("@ua");
      await settle();
      const option = document.querySelector<HTMLElement>(
        '[data-slot="mention-list"] [role="option"]'
      );
      await act(async () => option?.click());
      await settle();
      expect(chip()?.textContent).toBe("Heron Membership · UAT");
    });

    it("Esc closes the list and leaves the text", async () => {
      await renderWorkspace();
      const box = await type("@her");
      await settle();
      await press(box, "Escape");
      expect(options()).toEqual([]);
      expect(box.value).toBe("@her");
      expect(chip()?.textContent).toBe(t.contextAuto);
    });

    it("is announced as the box's autocomplete list", async () => {
      await renderWorkspace();
      const box = await type("@her");
      await settle();
      expect(box.getAttribute("aria-autocomplete")).toBe("list");
      const list = document.querySelector('[data-slot="mention-list"]');
      expect(list?.getAttribute("role")).toBe("listbox");
      expect(box.getAttribute("aria-controls")).toBe(list?.id);
      const first = list?.querySelector('[role="option"]');
      expect(box.getAttribute("aria-activedescendant")).toBe(first?.id);
      expect(first?.getAttribute("aria-selected")).toBe("true");
      await press(box, "Escape");
      expect(box.hasAttribute("aria-controls")).toBe(false);
      expect(box.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("@ inside words and code stays text and leaves the context alone", async () => {
      await renderWorkspace();
      const box = await type("use @Transactional please");
      await settle();
      expect(box.value).toBe("use @Transactional please");
      expect(options()).toEqual([]);
      await type("mail user@example.invalid");
      await settle();
      expect(options()).toEqual([]);
      expect(chip()?.textContent).toBe(t.contextAuto);
    });

    it("with no match says so briefly and Enter still sends", async () => {
      api.createConversation.mockResolvedValue({ id: CONV_ID });
      api.sendMessage.mockResolvedValue({});
      await renderWorkspace();
      const box = await type("use @Transactional");
      await settle();
      expect(options()).toEqual([]);
      expect(text()).toContain(t.mentionEmpty);
      await settle();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1600));
      });
      expect(text()).not.toContain(t.mentionEmpty);
      await press(box, "Enter");
      expect(api.sendMessage).toHaveBeenCalledWith({
        conversationId: CONV_ID,
        text: "use @Transactional",
        context: { kind: "auto" },
      });
    });

    it("an IME composition never picks or sends", async () => {
      await renderWorkspace();
      const box = await type("@her");
      await settle();
      const ev = await press(box, "Enter", { isComposing: true });
      expect(ev.defaultPrevented).toBe(false);
      expect(box.value).toBe("@her");
      expect(chip()?.textContent).toBe(t.contextAuto);
      await press(box, "Escape", { isComposing: true });
      expect(options()).toHaveLength(3);
    });

    it("leaves the context of earlier questions as they were", async () => {
      api.sendMessage.mockResolvedValue({});
      await renderWorkspace({ conversationId: CONV_ID }, [
        userMessage("u1", {
          kind: "project",
          label: "Globex Billing",
          deleted: false,
          projectId: "p2",
          environmentId: null,
        }),
        answer,
      ]);
      const bubble = () =>
        container.querySelector("[data-question-context]")?.textContent;
      expect(bubble()).toContain("Globex Billing");
      const box = await type("@her");
      await settle();
      await press(box, "Enter");
      expect(chip()?.textContent).toBe("Heron Membership");
      expect(bubble()).toContain("Globex Billing");
    });
  });

  it("with no visible project shows the not-available state, not the workspace", async () => {
    await renderWorkspace();
    act(() => root.unmount());
    container.remove();
    queryClient.setQueryData(["project-catalog", "listProjects", []], []);
    queryClient.setQueryData(["environments", "listEnvironments", []], []);
    await render(<AssistantWorkspace />);
    expect(text()).toContain(t.noProjectsTitle);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("an opened conversation starts at the context of its last question", async () => {
    await renderWorkspace({ conversationId: CONV_ID }, [
      userMessage("u1", {
        kind: "auto",
        label: null,
        deleted: false,
        projectId: null,
        environmentId: null,
      }),
      answer,
      userMessage("u2", {
        kind: "environment",
        label: "Heron Membership UAT",
        deleted: false,
        projectId: "p1",
        environmentId: ENV_2,
      }),
      { ...answer, id: "a2" },
    ]);
    expect(chip()?.textContent).toBe("Heron Membership · UAT");
  });

  it("a deleted environment falls back to its project; a lost project to Automatic", async () => {
    await renderWorkspace({ conversationId: CONV_ID }, [
      userMessage("u1", {
        kind: "environment",
        label: "Heron Membership Old",
        deleted: true,
        projectId: "p1",
        environmentId: null,
      }),
      answer,
    ]);
    expect(chip()?.textContent).toBe("Heron Membership");
    act(() => root.unmount());
    container.remove();
    await renderWorkspace({ conversationId: CONV_ID }, [
      userMessage("u1", {
        kind: "project",
        label: "Initech Payroll",
        deleted: false,
        projectId: "p9",
        environmentId: null,
      }),
      answer,
    ]);
    expect(chip()?.textContent).toBe(t.contextAuto);
  });

  it("a Stage 2 conversation shows its old questions with their context", async () => {
    await renderWorkspace({ conversationId: CONV_ID }, [
      userMessage("u1", contextOf("user", null, null)),
      answer,
      userMessage("u2", contextOf("user", ENV_ID, "Heron Membership Dev 1")),
      { ...answer, id: "a2" },
      userMessage("u3", contextOf("user", null, "Heron Membership Old", true)),
      { ...answer, id: "a3" },
    ]);
    const labels = [
      ...container.querySelectorAll<HTMLElement>("[data-question-context]"),
    ].map((el) => el.textContent);
    expect(labels).toEqual([
      "Heron Membership",
      "Heron Membership · Dev 1",
      // Its project is still there, so it is named with it.
      `Heron Membership · Old ${t.contextDeleted}`,
    ]);
  });

  it("New chat goes back to Automatic", async () => {
    await renderWorkspace({
      conversationId: CONV_ID,
      initialContext: { kind: "project", projectId: "p1" },
    });
    expect(chip()?.textContent).toBe("Heron Membership");
    await act(async () => button(t.newChat)?.click());
    expect(chip()?.textContent).toBe(t.contextAuto);
  });

  const openChatMenu = async (title: string) => {
    const row = [...document.querySelectorAll("nav li")].find((li) =>
      li.textContent?.includes(title)
    );
    const trigger = row?.querySelector<HTMLButtonElement>(
      `button[aria-label="${t.chatActions}"]`
    );
    if (!trigger) throw new Error("no chat menu");
    await act(async () => trigger.click());
    await settle();
  };
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === label
    );
  const titleField = () =>
    container.querySelector<HTMLInputElement>(
      `input[aria-label="${t.chatTitle}"]`
    );
  const typeTitle = async (value: string, key: string) => {
    const field = titleField();
    if (!field) throw new Error("no title field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(
        key === "blur"
          ? new FocusEvent("focusout", { bubbles: true })
          : new KeyboardEvent("keydown", { key, bubbles: true })
      );
    });
    await settle();
  };

  it("renames a chat in place: Enter saves, Escape cancels", async () => {
    api.renameConversation.mockResolvedValue({ id: CONV_ID });
    await renderWorkspace();
    await openChatMenu("Iuran");
    await act(async () => menuItem(t.renameChat)?.click());
    await settle();
    expect(titleField()?.value).toBe("Iuran");
    await typeTitle("Ditolak", "Escape");
    expect(titleField()).toBeNull();
    expect(api.renameConversation).not.toHaveBeenCalled();

    await openChatMenu("Iuran");
    await act(async () => menuItem(t.renameChat)?.click());
    await settle();
    await typeTitle("  Iuran   tambahan ", "Enter");
    expect(titleField()).toBeNull();
    expect(api.renameConversation).toHaveBeenCalledWith({
      conversationId: CONV_ID,
      title: "Iuran tambahan",
    });
  });

  it("saves a renamed title on blur; an empty or unchanged one cancels", async () => {
    api.renameConversation.mockResolvedValue({ id: CONV_ID });
    await renderWorkspace();
    const edit = async () => {
      await openChatMenu("Iuran");
      await act(async () => menuItem(t.renameChat)?.click());
      await settle();
    };
    for (const value of ["   ", "Iuran"]) {
      await edit();
      await typeTitle(value, "blur");
      expect(titleField()).toBeNull();
    }
    expect(api.renameConversation).not.toHaveBeenCalled();
    await edit();
    await typeTitle("Iuran baru", "blur");
    expect(titleField()).toBeNull();
    expect(api.renameConversation).toHaveBeenCalledWith({
      conversationId: CONV_ID,
      title: "Iuran baru",
    });
  });

  it("counts a title's characters, not UTF-16 units, and refuses more than 80", async () => {
    api.renameConversation.mockResolvedValue({ id: CONV_ID });
    await renderWorkspace();
    await openChatMenu("Iuran");
    await act(async () => menuItem(t.renameChat)?.click());
    await settle();
    expect(titleField()?.hasAttribute("maxlength")).toBe(false);
    const tooLong = t.chatTitleTooLong.replace("{max}", "80");
    for (const key of ["Enter", "blur"]) {
      await typeTitle("😀".repeat(81), key);
      expect(titleField()).not.toBeNull();
      expect(titleField()?.getAttribute("aria-invalid")).toBe("true");
      expect(text()).toContain(tooLong);
    }
    expect(api.renameConversation).not.toHaveBeenCalled();
    await typeTitle("😀".repeat(80), "Enter");
    expect(titleField()).toBeNull();
    expect(text()).not.toContain(tooLong);
    expect(api.renameConversation).toHaveBeenCalledWith({
      conversationId: CONV_ID,
      title: "😀".repeat(80),
    });
  });

  it("deletes the open chat after a confirmation and returns to a new chat", async () => {
    api.deleteConversation.mockResolvedValue({ id: CONV_ID });
    const onConversationChange = vi.fn();
    await renderWorkspace({ conversationId: CONV_ID, onConversationChange }, [
      userMessage("u1", contextOf("user", null, null)),
      answer,
    ]);
    expect(button(t.newDraft)).toBeDefined();
    await openChatMenu("Iuran");
    await act(async () => menuItem(t.deleteChat)?.click());
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(t.deleteChatConfirm);
    expect(dialog?.textContent).toContain("“Iuran”");
    expect(api.deleteConversation).not.toHaveBeenCalled();
    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === t.deleteChat
    );
    await act(async () => confirm?.click());
    await settle();
    expect(api.deleteConversation).toHaveBeenCalledWith(CONV_ID);
    expect(onConversationChange).toHaveBeenLastCalledWith(null);
    expect(button(t.newDraft)).toBeUndefined();
    expect(text()).toContain(t.emptyThreadTitle);
    expect(
      queryClient.getQueryData(["assistant", "getConversation", [CONV_ID]])
    ).toBeUndefined();
  });

  it("deleting another chat keeps the open one", async () => {
    api.deleteConversation.mockResolvedValue({ id: "c2" });
    const onConversationChange = vi.fn();
    await renderWorkspace(
      { conversationId: CONV_ID, onConversationChange },
      [userMessage("u1", contextOf("user", null, null)), answer],
      [
        {
          id: CONV_ID,
          title: "Iuran",
          updatedAt: "2026-11-16T01:00:00Z",
          lastContextLabel: null,
        },
        {
          id: "c2",
          title: "Tagihan",
          updatedAt: "2026-11-16T00:00:00Z",
          lastContextLabel: null,
        },
      ]
    );
    await openChatMenu("Tagihan");
    await act(async () => menuItem(t.deleteChat)?.click());
    await settle();
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button'
      ),
    ].find((b) => b.textContent?.trim() === t.deleteChat);
    await act(async () => confirm?.click());
    await settle();
    expect(api.deleteConversation).toHaveBeenCalledWith("c2");
    expect(onConversationChange).not.toHaveBeenCalled();
    expect(button(t.newDraft)).toBeDefined();
  });

  it("the conversation list shows each conversation's last context", async () => {
    await renderWorkspace(
      {},
      [],
      [
        {
          id: CONV_ID,
          title: "Iuran",
          updatedAt: "2026-11-16T01:00:00Z",
          lastContextLabel: "Heron Membership",
          lastContextDeleted: false,
        },
        {
          id: "c2",
          title: "Tagihan",
          updatedAt: "2026-11-16T00:00:00Z",
          lastContextLabel: null,
          lastContextDeleted: false,
        },
        {
          id: "c3",
          title: "Klaim",
          updatedAt: "2026-11-15T00:00:00Z",
          lastContextLabel: "Initech Payroll",
          lastContextDeleted: true,
        },
      ]
    );
    const rows = [...document.querySelectorAll("nav li")].map(
      (li) => li.textContent ?? ""
    );
    expect(rows[0]).toContain("Heron Membership");
    expect(rows[0]).not.toContain(t.contextDeleted);
    expect(rows[1]).toContain(t.contextAuto);
    expect(rows[2]).toContain(`Initech Payroll ${t.contextDeleted}`);
  });

  it("reports the selected conversation for the URL", async () => {
    const onConversationChange = vi.fn();
    await renderWorkspace({ onConversationChange });
    const row = [...document.querySelectorAll("nav button")].find((b) =>
      b.textContent?.includes("Iuran")
    ) as HTMLButtonElement | undefined;
    await act(async () => row?.click());
    expect(onConversationChange).toHaveBeenLastCalledWith(CONV_ID);
  });

  it("locks the chip while an answer is running", async () => {
    await renderWorkspace({ conversationId: CONV_ID }, [
      userMessage("u1", contextOf("user", null, null)),
      { ...answer, status: "streaming" },
    ]);
    expect(chip()?.hasAttribute("disabled")).toBe(true);
  });

  it("drops a ?c= conversation that is not found", async () => {
    const missing = "8b9d7a10-1c2d-4e5f-8a9b-0c1d2e3f4aff";
    conversationFetch.set(missing, () =>
      Promise.reject(new ApiError(404, "Not Found"))
    );
    const onConversationChange = vi.fn();
    await renderWorkspace({ conversationId: missing, onConversationChange });
    await settle();
    expect(onConversationChange).toHaveBeenLastCalledWith(null);
    expect(button(t.newDraft)).toBeUndefined();
  });

  it("does not show an old draft error again after the panel is reopened", async () => {
    api.generateDraft.mockRejectedValue(new ApiError(504, "Gateway Timeout"));
    await renderWorkspace({ conversationId: CONV_ID }, [
      userMessage("u1", contextOf("user", null, null)),
      answer,
    ]);
    await act(async () => button(t.newDraft)?.click());
    await settle();
    const brd = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((el) => el.textContent?.includes(t.newDraftBrd));
    await act(async () => brd?.click());
    await settle();
    expect(text()).toContain(messages.assistantErrors.failed);
    const toggle = () => button(t.drafts.replace("{count}", "0"));
    await act(async () => toggle()?.click());
    await act(async () => toggle()?.click());
    await settle();
    expect(
      document.querySelector('section[aria-label="Drafts"]')
    ).not.toBeNull();
    expect(text()).not.toContain(messages.assistantErrors.failed);
  });

  it("New draft › Issue opens the panel and generates an issue draft", async () => {
    api.generateDraft.mockResolvedValue({});
    await renderWorkspace({ conversationId: CONV_ID }, [
      userMessage("u1", contextOf("user", null, null)),
      answer,
    ]);
    expect(document.querySelector('section[aria-label="Drafts"]')).toBeNull();
    await act(async () => button(t.newDraft)?.click());
    await settle();
    const issue = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((el) => el.textContent?.includes(t.newDraftIssue));
    await act(async () => issue?.click());
    await settle();
    expect(
      document.querySelector('section[aria-label="Drafts"]')
    ).not.toBeNull();
    expect(api.generateDraft).toHaveBeenCalledWith({
      conversationId: CONV_ID,
      kind: "jira",
    });
  });
});

describe("question bubble context", () => {
  const question = {
    id: "u1",
    role: "user" as const,
    content: "Q",
    status: "done" as const,
    errorCode: null,
    sources: null,
    attachmentIds: [],
    createdAt: "2026-11-16T01:00:00Z",
    toolCalls: [],
    context: contextOf("user", null, null),
  };
  const label = () =>
    container.querySelector("[data-question-context]")?.textContent;
  const renderQuestion = (context: unknown) => {
    seedCatalog();
    return render(<MessageView message={{ ...question, context } as never} />);
  };

  it("names an automatic question", async () => {
    await renderQuestion({
      kind: "auto",
      label: null,
      deleted: false,
      projectId: null,
      environmentId: null,
    });
    expect(label()).toBe(t.contextAuto);
  });

  it("names the project it asked about", async () => {
    await renderQuestion(contextOf("user", null, null));
    expect(label()).toBe("Heron Membership");
  });

  it("names the environment with its project", async () => {
    await renderQuestion(contextOf("user", ENV_ID, "Heron Membership Dev 1"));
    expect(label()).toBe("Heron Membership · Dev 1");
    expect(text()).not.toContain(t.contextDeleted);
  });

  it("keeps the stored name of an environment whose project it cannot see", async () => {
    await renderQuestion({
      kind: "environment",
      label: "Initech Staging",
      deleted: false,
      projectId: "p9",
      environmentId: ENV_ID,
    });
    expect(label()).toBe("Initech Staging");
  });

  it("marks a deleted context (deleted)", async () => {
    await renderQuestion(
      contextOf("user", null, "Heron Membership Dev 1", true)
    );
    expect(label()).toBe(`Heron Membership · Dev 1 ${t.contextDeleted}`);
    act(() => root.unmount());
    container.remove();
    await renderQuestion({
      kind: "project",
      label: "Initech Payroll",
      deleted: true,
      projectId: null,
      environmentId: null,
    });
    expect(label()).toBe(`Initech Payroll ${t.contextDeleted}`);
    expect(t.contextDeleted).toBe("(deleted)");
  });
});

describe("attachment picker", () => {
  it("shows already-picked attachments locked and counts them in the limit", async () => {
    queryClient.setQueryData(["assistant", "listIssueAttachments", ["KST-1"]], {
      key: "KST-1",
      unavailable: false,
      attachments: [
        {
          id: "1",
          filename: "a.xlsx",
          mime: "application/xlsx",
          sizeBytes: 10,
        },
        {
          id: "2",
          filename: "b.pdf",
          mime: "application/pdf",
          sizeBytes: 20,
        },
        { id: "3", filename: "c.png", mime: "image/png", sizeBytes: 30 },
      ],
    });
    const onAdd = vi.fn();
    await render(
      <AttachmentPicker
        open
        onOpenChange={() => {}}
        max={2}
        picked={new Set(["1"])}
        onAdd={onAdd}
      />
    );
    const input = document.querySelector<HTMLInputElement>(
      "#assistant-issue-key"
    );
    if (!input) throw new Error("no input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "kst-1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(t.showAttachments)?.click());
    const box = (id: string) =>
      document.querySelector(
        `[role="checkbox"][aria-labelledby="assistant-attachment-${id}-label"]`
      );
    expect(box("1")?.getAttribute("aria-checked")).toBe("true");
    expect(box("1")?.hasAttribute("data-disabled")).toBe(true);
    // One slot left of two: ticking b.pdf locks c.png.
    await act(async () => (box("2") as HTMLElement | null)?.click());
    expect(box("2")?.getAttribute("aria-checked")).toBe("true");
    expect(box("3")?.hasAttribute("data-disabled")).toBe(true);
    await act(async () => button("Use 1 attachment")?.click());
    expect(onAdd).toHaveBeenCalledWith([
      { id: "2", filename: "b.pdf", issueKey: "KST-1" },
    ]);
  });
});

describe("assistant messages", () => {
  const load = (locale: string) =>
    JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as {
      assistant: Record<string, string>;
      assistantErrors: Record<string, string>;
      breadcrumbs: Record<string, string>;
      nav: Record<string, string>;
      common: Record<string, string>;
    };
  const en = load("en");

  for (const locale of locales) {
    it(`${locale} has every assistant key`, () => {
      const m = load(locale);
      expect(Object.keys(m.assistant).sort()).toEqual(
        Object.keys(en.assistant).sort()
      );
      expect(Object.keys(m.assistantErrors).sort()).toEqual(
        Object.keys(en.assistantErrors).sort()
      );
      for (const value of Object.values(m.assistant)) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
      expect(m.breadcrumbs.assistant?.length).toBeGreaterThan(0);
      expect(m.nav.assistant?.length).toBeGreaterThan(0);
    });
  }

  it("every key the components use exists", () => {
    const dir = "web/components/assistant";
    // `t` / `tAssistant` read `assistant`; `tErrors` `assistantErrors`;
    // `tCommon` `common`.
    const namespaces: Record<string, Record<string, string>> = {
      t: en.assistant,
      tAssistant: en.assistant,
      tErrors: en.assistantErrors,
      tCommon: en.common,
    };
    const files = [
      ...readdirSync(dir).map((f) => `${dir}/${f}`),
      "web/routes/$locale/_app/assistant.tsx",
    ];
    const missing: string[] = [];
    let used = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /\b(t|tAssistant|tErrors|tCommon)\("([a-zA-Z]+)"/g
      )) {
        const [, fn = "", key = ""] = match;
        used++;
        if (!(key in (namespaces[fn] ?? {}))) missing.push(`${fn}:${key}`);
      }
    }
    expect(used).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});

describe("wording", () => {
  it("calls them chats and the feature the Assistant, in every locale's assistant copy", () => {
    const banned: Record<string, RegExp> = {
      en: /conversation|code assistant/i,
      id: /percakapan|asisten kode/i,
      es: /conversaci|asistente de código/i,
      ar: /محادث|مساعد الشيفرة/,
      zh: /对话|代码助手/,
    };
    for (const locale of locales) {
      const all = JSON.parse(
        readFileSync(`messages/${locale}.json`, "utf8")
      ) as Record<string, Record<string, unknown>>;
      const copy = JSON.stringify([
        all.assistant,
        all.assistantSettings,
        all.assistantErrors,
        all.homePage?.askRecent,
      ]);
      expect(copy, locale).not.toMatch(banned[locale] as RegExp);
    }
    expect(t.newChat).toBe("New chat");
    expect(t.chats).toBe("Chats");
    expect(t.untitled).toBe("New chat");
    expect(messages.assistantSettings.title).toBe("Assistant");
  });
});
