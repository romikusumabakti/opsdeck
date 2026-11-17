// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  allowedEmailDomain: "example.com",
});

const api = vi.hoisted(() => ({
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@/web/api/assistant", () => ({
  getAllowanceQuery: () => ({
    queryKey: ["assistant", "getAllowance"],
    queryFn: () => new Promise(() => {}),
  }),
  listConversationsQuery: () => ({
    queryKey: ["assistant", "listConversations"],
    queryFn: () => new Promise(() => {}),
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
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  api.createConversation.mockReset();
  api.sendMessage.mockReset();
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
    queryClient.setQueryData(
      ["assistant", "listConversations"],
      opts.conversations ?? []
    );
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
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter() {
  await act(async () => {
    box().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

describe("home ask-the-assistant card", () => {
  it("is hidden when the assistant is not enabled", async () => {
    await renderCard({ allowance: { ...ENABLED, enabled: false } });
    expect(container.textContent).toBe("");
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

  it("styles the limit message as a notice, not an error", async () => {
    await renderCard({ allowance: { ...ENABLED, capReached: true } });
    const note = container.querySelector('[role="status"]');
    expect(note?.className).not.toContain("text-destructive");
  });
});
