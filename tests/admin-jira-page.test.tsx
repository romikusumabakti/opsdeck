// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: vi.fn(), confirmTyping: vi.fn() }),
}));
vi.mock("@/web/api/jira", () => ({ deleteJiraConnection: vi.fn() }));

const { JiraClient } = await import(
  "../web/routes/$locale/_app/-components/admin/jira/jira-client"
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const connection = (id: string, name: string) => ({
  id,
  name,
  baseUrl: `https://${id}.atlassian.net`,
  flavor: "cloud" as const,
  email: null,
  hasToken: true,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  webhookUrl: `https://panel.test/api/jira/webhook/secret-${id}`,
});

async function render(connections: ReturnType<typeof connection>[]) {
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <JiraClient connections={connections as never} />
      </IntlProvider>
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("JiraClient", () => {
  it("renders one card per connection with edit link and webhook URL", async () => {
    await render([connection("j1", "Acme"), connection("j2", "Beta")]);
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(2);
    expect(container.querySelector('a[href="/admin/jira/j1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/jira/j2"]')).not.toBeNull();
    expect(container.textContent).toContain("/api/jira/webhook/secret-j1");
    expect(container.textContent).toContain("/api/jira/webhook/secret-j2");
    expect(container.querySelector("table")).toBeNull();
  });

  it("shows the empty state without connections", async () => {
    await render([]);
    expect(container.textContent).toContain(messages.jira.emptyTitle);
  });
});
