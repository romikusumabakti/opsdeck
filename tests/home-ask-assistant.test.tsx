// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import { composerDrafts } from "@/web/components/assistant/composer-drafts";
import { ME_QUERY_KEY } from "@/web/query-client";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  allowedEmailDomain: "example.com",
});

const api = vi.hoisted(() => ({
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
  listConversations: vi.fn(() => new Promise(() => {})),
  uploadFile: vi.fn(),
  deleteUpload: vi.fn(),
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@/web/api/assistant", () => ({
  getAllowanceQuery: () => ({
    queryKey: ["assistant", "getAllowance"],
    queryFn: () => new Promise(() => {}),
  }),
  listConversationsQuery: () => ({
    queryKey: ["assistant", "listConversations"],
    queryFn: api.listConversations,
  }),
  ...api,
}));
vi.mock("@/web/api/environments", () => ({
  listEnvironmentsQuery: () => ({
    queryKey: ["environments", "listEnvironments"],
    queryFn: () => new Promise(() => {}),
  }),
}));
vi.mock("@/web/api/project-catalog", () => ({
  listProjectsQuery: () => ({
    queryKey: ["project-catalog", "listProjects", []],
    queryFn: () => new Promise(() => {}),
  }),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  Link: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AskAssistantCard } from "@/web/routes/$locale/_app/-components/home/ask-assistant-card";

const PROJECTS = [
  { id: "p1", key: "ACME", name: "Acme Shop" },
  { id: "p2", key: "GLOBEX", name: "Globex" },
];
const ENABLED = {
  enabled: true,
  usedFraction: 0.1,
  capReached: false,
  resetsAt: "2026-11-17T17:00:00.000Z",
  readsImages: true,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(ME_QUERY_KEY, {
    user: { id: "user-1" },
    orgRole: "member",
    timeZone: "UTC",
  });
  composerDrafts.resetForTests();
  api.createConversation.mockReset();
  api.sendMessage.mockReset();
  api.uploadFile.mockReset();
  api.deleteUpload.mockReset();
  api.listConversations.mockClear();
  nav.push.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const CONVERSATIONS = [
  {
    id: "c1",
    title: "Login flow",
    lastContextLabel: "Acme Shop",
    updatedAt: new Date().toISOString(),
  },
  {
    id: "c2",
    title: "Deploys",
    lastContextLabel: null,
    updatedAt: new Date().toISOString(),
  },
  {
    id: "c3",
    title: "Billing",
    lastContextLabel: "Globex",
    updatedAt: new Date().toISOString(),
  },
  {
    id: "c4",
    title: "Fourth",
    lastContextLabel: null,
    updatedAt: new Date().toISOString(),
  },
];

async function renderCard(opts: {
  allowance?: object;
  projects?: object[];
  /** null: the conversations are still loading. */
  conversations?: object[] | null;
}) {
  if (opts.conversations !== null) {
    queryClient.setQueryData(["assistant", "listConversations"], {
      pinned: [],
      recent: opts.conversations ?? [],
    });
  }
  queryClient.setQueryData(["environments", "listEnvironments"], []);
  queryClient.setQueryData(
    ["assistant", "getAllowance"],
    opts.allowance ?? ENABLED
  );
  queryClient.setQueryData(
    ["project-catalog", "listProjects", []],
    opts.projects ?? PROJECTS
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <AskAssistantCard />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

const box = () => {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("no textarea");
  return el;
};

async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(box(), text);
    box().setSelectionRange(text.length, text.length);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  const ev = new KeyboardEvent("keydown", {
    key,
    shiftKey: false,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    box().dispatchEvent(ev);
  });
  return ev;
}

const pressEnter = () => press("Enter");

const mentionOptions = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="mention-list"] [role="option"]'
    ),
  ].map((o) => o.textContent);

describe("home ask-the-assistant card", () => {
  it("is hidden when the assistant is not enabled", async () => {
    await renderCard({ allowance: { ...ENABLED, enabled: false } });
    expect(container.textContent).toBe("");
  });

  it("does not load conversations when the assistant is off or no project is visible", async () => {
    // Nothing cached, so an enabled query would call the (mocked) endpoint.
    queryClient.setQueryData(["environments", "listEnvironments"], []);
    queryClient.setQueryData(["assistant", "getAllowance"], {
      ...ENABLED,
      enabled: false,
    });
    queryClient.setQueryData(["project-catalog", "listProjects", []], PROJECTS);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <AskAssistantCard />
          </IntlProvider>
        </QueryClientProvider>
      );
    });
    expect(api.listConversations).not.toHaveBeenCalled();
    await act(async () => {
      queryClient.setQueryData(["assistant", "getAllowance"], ENABLED);
      queryClient.setQueryData(["project-catalog", "listProjects", []], []);
    });
    expect(api.listConversations).not.toHaveBeenCalled();
    await act(async () => {
      queryClient.setQueryData(
        ["project-catalog", "listProjects", []],
        PROJECTS
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.listConversations).toHaveBeenCalledTimes(1);
  });

  it("is hidden when the user sees no project", async () => {
    await renderCard({ projects: [] });
    expect(container.textContent).toBe("");
  });

  it("shows three example questions and no recents with no conversations", async () => {
    await renderCard({});
    const examples = container.querySelectorAll("[data-example]");
    expect(examples).toHaveLength(3);
    expect(container.querySelector("[data-recent]")).toBeNull();
  });

  it("shows neither examples nor recents while the conversations load", async () => {
    await renderCard({ conversations: null });
    expect(box()).toBeTruthy();
    expect(container.querySelector("[data-example]")).toBeNull();
    expect(container.querySelector("[data-recent]")).toBeNull();
  });

  it("an example fills the prompt without sending", async () => {
    await renderCard({});
    const first = container.querySelector<HTMLButtonElement>("[data-example]");
    await act(async () => first?.click());
    expect(box().value).toBe(first?.textContent);
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("shows at most three recents with context and time, linking to them", async () => {
    await renderCard({ conversations: CONVERSATIONS });
    expect(container.querySelector("[data-example]")).toBeNull();
    const recents = [...container.querySelectorAll("a[data-recent]")];
    expect(recents.map((a) => a.getAttribute("href"))).toEqual([
      "/assistant?c=c1",
      "/assistant?c=c2",
      "/assistant?c=c3",
    ]);
    expect(recents[0]?.textContent).toContain("Login flow");
    expect(recents[0]?.textContent).toContain("Acme Shop");
    expect(recents[1]?.textContent).toContain("Automatic");
    expect(recents[0]?.querySelector("time")).not.toBeNull();
  });

  it("starts with the Automatic context chip", async () => {
    await renderCard({});
    expect(
      container.querySelector('[aria-label="Context: Automatic"]')
    ).not.toBeNull();
  });

  it("Enter creates the conversation, sends the question and opens it", async () => {
    api.createConversation.mockResolvedValue({ id: "c1" });
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    await type("Where is login handled?");
    await pressEnter();
    expect(api.createConversation).toHaveBeenCalledExactlyOnceWith();
    expect(api.sendMessage).toHaveBeenCalledWith({
      conversationId: "c1",
      text: "Where is login handled?",
      context: { kind: "auto" },
    });
    expect(nav.push).toHaveBeenCalledWith("/assistant?c=c1");
  });

  it("Shift+Enter inserts a newline and does not send", async () => {
    await renderCard({});
    await type("Hello");
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      box().dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("is disabled with the reset message when the daily limit is reached", async () => {
    await renderCard({ allowance: { ...ENABLED, capReached: true } });
    expect(box().disabled).toBe(true);
    expect(container.textContent).toContain("You've reached today's limit");
  });

  it("shows a failed send inline and stays on the page", async () => {
    api.createConversation.mockRejectedValue(new Error("boom"));
    await renderCard({});
    await type("Hello");
    await pressEnter();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(nav.push).not.toHaveBeenCalled();
    expect(box().value).toBe("Hello");
  });

  it("reuses the created conversation when a send is retried", async () => {
    api.createConversation.mockResolvedValue({ id: "c1" });
    api.sendMessage.mockRejectedValueOnce(new Error("boom"));
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    await type("Hello");
    await pressEnter();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await pressEnter();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "c1" })
    );
    expect(nav.push).toHaveBeenCalledWith("/assistant?c=c1");
  });

  it("reuses the created conversation when the context changed before the retry", async () => {
    api.createConversation.mockResolvedValue({ id: "c1" });
    api.sendMessage.mockRejectedValueOnce(new Error("boom"));
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    await type("Hello");
    await pressEnter();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label^="Context"]')?.click()
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((o) => o.textContent === "Acme Shop");
    if (!option) throw new Error("no project option");
    await act(async () => option.click());
    await pressEnter();
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        conversationId: "c1",
        context: { kind: "project", projectId: "p1" },
      })
    );
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it("sends once when Enter is pressed again before the page changes", async () => {
    api.createConversation.mockResolvedValue({ id: "c1" });
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    await type("Hello");
    await pressEnter();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await pressEnter();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("@ mentions a project anywhere in the box and sets the chip", async () => {
    await renderCard({});
    await type("Where is login in @acm");
    expect(mentionOptions()).toEqual(["Acme Shop"]);
    const ev = await pressEnter();
    expect(ev.defaultPrevented).toBe(true);
    expect(box().value).toBe("Where is login in @Acme Shop ");
    expect(
      container.querySelector('[aria-label="Context: Acme Shop"]')
    ).not.toBeNull();
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("Esc closes the mention list and leaves the text", async () => {
    await renderCard({});
    await type("@glo");
    expect(mentionOptions()).toEqual(["Globex"]);
    await press("Escape");
    expect(mentionOptions()).toEqual([]);
    expect(box().value).toBe("@glo");
    expect(
      container.querySelector('[aria-label="Context: Automatic"]')
    ).not.toBeNull();
  });

  it("@ in code or an address stays text and Enter sends", async () => {
    api.createConversation.mockResolvedValue({ id: "c1" });
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    await type("use @Transactional please");
    expect(mentionOptions()).toEqual([]);
    await pressEnter();
    expect(api.sendMessage).toHaveBeenCalledWith({
      conversationId: "c1",
      text: "use @Transactional please",
      context: { kind: "auto" },
    });
  });

  it("styles the limit message as a notice, not an error", async () => {
    await renderCard({ allowance: { ...ENABLED, capReached: true } });
    const note = container.querySelector('[role="status"]');
    expect(note?.className).not.toContain("text-destructive");
  });
});

describe("home box files", () => {
  const png = (name: string) =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name);
  const chips = () => [...container.querySelectorAll("[data-file-chip]")];

  it("a dropped and a pasted file become chips and go with the question", async () => {
    let n = 0;
    api.uploadFile.mockImplementation(async (file: File) => ({
      id: `u${++n}`,
      filename: file.name,
      mediaType: "image/png",
      size: file.size,
    }));
    api.createConversation.mockResolvedValue({ id: "c9" });
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    const card = box().parentElement as HTMLElement;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files: [png("drop.png")] },
      });
      await act(async () => {
        card.dispatchEvent(event);
      });
    }
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [png("paste.png")], getData: () => "" },
    });
    await act(async () => {
      box().dispatchEvent(paste);
    });
    expect(chips().map((c) => c.textContent)).toEqual([
      expect.stringContaining("drop.png"),
      expect.stringContaining("paste.png"),
    ]);
    expect(container.textContent).toContain(messages.assistant.fileWarning);
    await type("What do these show?");
    await pressEnter();
    expect(api.sendMessage).toHaveBeenCalledWith({
      conversationId: "c9",
      text: "What do these show?",
      context: { kind: "auto" },
      fileIds: ["u1", "u2"],
    });
  });

  it("files do not come back after a send or a remount", async () => {
    api.uploadFile.mockResolvedValue({
      id: "u1",
      filename: "a.png",
      mediaType: "image/png",
      size: 1,
    });
    api.createConversation.mockResolvedValue({ id: "c9" });
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    const picker = container.querySelector(
      "input[type=file]"
    ) as HTMLInputElement;
    Object.defineProperty(picker, "files", { value: [png("a.png")] });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(chips()).toHaveLength(1);
    await type("Look");
    await pressEnter();
    expect(chips()).toHaveLength(0);
    await act(async () => root.unmount());
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <AskAssistantCard />
          </IntlProvider>
        </QueryClientProvider>
      );
    });
    expect(chips()).toHaveLength(0);
    expect(api.deleteUpload).not.toHaveBeenCalled();
  });

  async function attachReadyFile() {
    api.deleteUpload.mockResolvedValue(undefined);
    api.uploadFile.mockResolvedValue({
      id: "u1",
      filename: "a.png",
      mediaType: "image/png",
      size: 1,
    });
    await renderCard({});
    const picker = container.querySelector(
      "input[type=file]"
    ) as HTMLInputElement;
    Object.defineProperty(picker, "files", { value: [png("a.png")] });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(chips()).toHaveLength(1);
  }

  it("leaving with an unsent file deletes it", async () => {
    await attachReadyFile();
    await act(async () => root.unmount());
    expect(api.deleteUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).toHaveBeenCalledWith("u1");
  });

  it("leaving while the question is being sent keeps its files", async () => {
    await attachReadyFile();
    let resolveCreate: (v: { id: string }) => void = () => {};
    api.createConversation.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );
    api.sendMessage.mockResolvedValue({});
    await type("Look");
    await pressEnter();
    await act(async () => root.unmount());
    expect(api.deleteUpload).not.toHaveBeenCalled();
    await act(async () => {
      resolveCreate({ id: "c9" });
    });
    expect(api.sendMessage).toHaveBeenCalledWith({
      conversationId: "c9",
      text: "Look",
      context: { kind: "auto" },
      fileIds: ["u1"],
    });
    expect(api.deleteUpload).not.toHaveBeenCalled();
  });

  it("the 📎 button opens the file picker", async () => {
    await renderCard({});
    const input = container.querySelector<HTMLInputElement>(
      "[data-testid=home-file-input]"
    );
    if (!input) throw new Error("no input");
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${messages.assistant.attachFiles}"]`
        )
        ?.click()
    );
    expect(click).toHaveBeenCalled();
  });
});
