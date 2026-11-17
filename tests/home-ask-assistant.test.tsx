// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  ...api,
}));
vi.mock("@/web/api/project-catalog", () => ({
  listProjectsQuery: () => ({
    queryKey: ["project-catalog", "listProjects", []],
    queryFn: () => new Promise(() => {}),
  }),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
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

async function renderCard(opts: { allowance?: object; projects?: object[] }) {
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

async function press(shiftKey: boolean) {
  await act(async () => {
    box().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey,
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

  it("lists only the visible projects and defaults to the first one", async () => {
    await renderCard({});
    const trigger = container.querySelector('[data-slot="combobox-trigger"]');
    expect(trigger?.textContent).toContain("Acme Shop");
    await act(async () =>
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    const items = [
      ...document.querySelectorAll('[data-slot="combobox-item"]'),
    ].map((el) => el.textContent);
    expect(items).toEqual(["Acme Shop", "Globex"]);
  });

  it("Enter creates the conversation, sends the question and opens it", async () => {
    api.createConversation.mockResolvedValue({ id: "c1" });
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    await type("Where is login handled?");
    await press(false);
    expect(api.createConversation).toHaveBeenCalledExactlyOnceWith();
    expect(api.sendMessage).toHaveBeenCalledWith({
      conversationId: "c1",
      text: "Where is login handled?",
      context: { kind: "project", projectId: "p1" },
    });
    expect(nav.push).toHaveBeenCalledWith("/ACME/assistant?c=c1");
  });

  it("Shift+Enter does not send", async () => {
    await renderCard({});
    await type("Hello");
    await press(true);
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
    await press(false);
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
    await press(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await press(false);
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "c1" })
    );
    expect(nav.push).toHaveBeenCalledWith("/ACME/assistant?c=c1");
  });

  it("sends once when Enter is pressed again before the page changes", async () => {
    api.createConversation.mockResolvedValue({ id: "c1" });
    api.sendMessage.mockResolvedValue({});
    await renderCard({});
    await type("Hello");
    await press(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await press(false);
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("styles the limit message as a notice, not an error", async () => {
    await renderCard({ allowance: { ...ENABLED, capReached: true } });
    const note = container.querySelector('[role="status"]');
    expect(note?.className).not.toContain("text-destructive");
  });
});
