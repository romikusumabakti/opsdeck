// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("@/web/api/activity", () => ({
  listActivityQuery: () => ({
    queryKey: ["activity", "listActivity"],
    queryFn: async () => [],
  }),
}));

import { Route } from "../web/routes/$locale/_app/admin.activity";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, action: string, data: Record<string, unknown>) => ({
  id,
  action,
  data,
  actorId: null,
  actorName: "Rina",
  actorImage: null,
  createdAt: new Date().toISOString(),
});

async function renderEvents(events: ReturnType<typeof row>[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["activity", "listActivity"], events);
  const Page = Route.options.component as React.ComponentType;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          <Page />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  const text = container.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

describe("activity page membership events", () => {
  // New member.added rows carry no role; rows written before the global-roles
  // release still do, and so do member.roleChanged rows.
  it("renders member.added with and without a role, and old role changes", async () => {
    const text = await renderEvents([
      row("1", "member.added", { user: "Aisha", project: "Kestrel" }),
      row("2", "member.added", {
        user: "Raja",
        project: "Kestrel",
        role: "engineer",
      }),
      row("3", "member.roleChanged", {
        user: "Raja",
        project: "Kestrel",
        from: "engineer",
        to: "qa",
      }),
    ]);
    expect(text).toContain("Rina added Aisha to Kestrel");
    expect(text).not.toContain("as undefined");
    expect(text).toContain("Rina added Raja to Kestrel as engineer");
    expect(text).toContain("Rina changed Raja in Kestrel from engineer to qa");
  });
});

describe("activity page file explorer events", () => {
  it("renders each file action as a sentence", async () => {
    const events = [
      row("1", "files.save", { target: "web-1", path: "etc/a.conf" }),
      row("2", "files.rename", { target: "web-1", path: "a", to: "b" }),
      row("3", "files.compress", {
        target: "web-1",
        path: "a",
        count: 3,
        archive: "x.zip",
      }),
      row("4", "files.download", { target: "bucket", path: "" }),
      row("5", "files.read", { target: "web-1", path: "app/.env" }),
    ];
    const queryClient = new QueryClient();
    queryClient.setQueryData(["activity", "listActivity"], events);
    const Page = Route.options.component as React.ComponentType;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IntlProvider locale="en" messages={messages}>
            <Page />
          </IntlProvider>
        </QueryClientProvider>
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Rina saved etc/a.conf on web-1");
    expect(text).toContain("Rina renamed a to b on web-1");
    expect(text).toContain(
      "Rina compressed a and 3 items in total into x.zip on web-1"
    );
    expect(text).toContain("Rina downloaded / from bucket");
    expect(text).toContain("Rina opened app/.env on web-1");
    expect(text).not.toContain("did something");
    await act(async () => root.unmount());
  });
});
