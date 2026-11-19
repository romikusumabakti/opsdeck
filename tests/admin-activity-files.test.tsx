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
      row("1", "member.added", { user: "Annisa", project: "Kestrel" }),
      row("2", "member.added", {
        user: "Raka",
        project: "Kestrel",
        role: "engineer",
      }),
      row("3", "member.roleChanged", {
        user: "Raka",
        project: "Kestrel",
        from: "engineer",
        to: "qa",
      }),
    ]);
    expect(text).toContain("Rina added Annisa to Kestrel");
    expect(text).not.toContain("as undefined");
    expect(text).toContain("Rina added Raka to Kestrel as engineer");
    expect(text).toContain("Rina changed Raka in Kestrel from engineer to qa");
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

  it("renders project source and default branch events", async () => {
    const events = [
      row("1", "project.sourceAdded", {
        project: "Kestrel Membership",
        app: "acme-membership",
      }),
      row("2", "project.sourceRemoved", {
        project: "Kestrel Membership",
        app: "acme-membership",
      }),
      row("3", "project.defaultBranchChanged", {
        project: "Kestrel Membership",
        component: "backend",
        from: "",
        to: "kestrel/development",
      }),
      row("4", "project.defaultBranchChanged", {
        project: "Kestrel Membership",
        component: "backend",
        from: "kestrel/demo",
        to: "kestrel/development",
      }),
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
    expect(text).toContain(
      "Rina added acme-membership to the sources of Kestrel Membership"
    );
    expect(text).toContain(
      "Rina removed acme-membership from the sources of Kestrel Membership"
    );
    expect(text).toContain(
      "Rina set the default branch of backend in Kestrel Membership to kestrel/development"
    );
    expect(text).toContain(
      "Rina changed the default branch of backend in Kestrel Membership from kestrel/demo to kestrel/development"
    );
    expect(text).not.toContain("did something");
    await act(async () => root.unmount());
  });
});

describe("activity page assistant events", () => {
  it("renders assistant.configured without the key", async () => {
    const text = await renderEvents([
      row("1", "assistant.configured", {
        enabled: "true",
        model: "acme-large",
        effort: "medium",
        dailyCapUsd: 1.5,
        keyChanged: "true",
        orgContextChanged: "true",
      }),
      row("4", "assistant.configured", {
        enabled: "true",
        model: "gpt-6-luna",
        effort: "low",
        dailyCapUsd: 1,
        providerChanged: "true",
        keyChanged: "true",
        modelChanged: "true",
        pricesChanged: "true",
        orgContextChanged: "false",
      }),
      row("2", "assistant.configured", {
        enabled: "false",
        model: "acme-max",
        effort: "high",
        dailyCapUsd: 3,
        keyChanged: "false",
      }),
      // Recorded before orgContextChanged existed.
      row("3", "assistant.configured", {
        enabled: "false",
        model: "acme-max",
        effort: "low",
        dailyCapUsd: 2,
        keyChanged: "false",
      }),
    ]);
    expect(text).toContain(
      "updated the assistant settings: enabled, acme-large, effort medium, limit 1.5 USD per user per day, API key changed, organisation context changed"
    );
    expect(text).toContain(
      "disabled, acme-max, effort low, limit 2 USD per user per day"
    );
    expect(text.match(/organisation context changed/g)).toHaveLength(1);
    expect(text).toContain(
      "enabled, gpt-6-luna, effort low, limit 1 USD per user per day, API key changed, provider changed, prices changed"
    );
    expect(text.match(/provider changed/g)).toHaveLength(1);
    expect(text).toContain(
      "disabled, acme-max, effort high, limit 3 USD per user per day"
    );
  });
});

describe("activity page variable import events", () => {
  it("renders variables.imported from text and from server, names only", async () => {
    const text = await renderEvents([
      row("1", "variables.imported", {
        environment: "Kestrel Dev",
        source: "text",
        names: "APP_NAME, DB_PASSWORD",
        overwritten: "APP_NAME",
      }),
      row("2", "variables.imported", {
        environment: "Kestrel Dev",
        source: "server",
        names: "LOG_LEVEL",
        overwritten: "",
        dirs: "kestrel-app:/srv/kestrel",
      }),
    ]);
    expect(text).toContain(
      "Rina imported variables into Kestrel Dev from pasted or uploaded text (APP_NAME, DB_PASSWORD; replaced: APP_NAME)"
    );
    expect(text).toContain(
      "Rina imported variables into Kestrel Dev from the server .env in kestrel-app:/srv/kestrel (LOG_LEVEL)"
    );
  });
});

describe("activity page managed .env events", () => {
  it("renders envFileManagedOn with the confirmed preview changes, old rows as before", async () => {
    const text = await renderEvents([
      row("1", "variables.envFileManagedOn", {
        environment: "Kestrel Dev",
        acknowledgedChanges: 3,
      }),
      row("2", "variables.envFileManagedOn", {
        environment: "Kestrel QA",
        acknowledgedChanges: 0,
      }),
      row("3", "variables.envFileManagedOn", { environment: "Kestrel UAT" }),
    ]);
    expect(text).toContain(
      "Rina let the Panel write the .env of Kestrel Dev after confirming 3 previewed changes"
    );
    expect(text).toContain(
      "Rina let the Panel write the .env of Kestrel QA with no previewed changes"
    );
    expect(text).toContain("Rina let the Panel write the .env of Kestrel UAT");
    expect(text).not.toContain("Kestrel UAT after");
    expect(text).not.toContain("Kestrel UAT with");
  });
});

describe("activity page project group events", () => {
  it("renders each group action as a sentence", async () => {
    const text = await renderEvents([
      row("1", "projectGroup.created", { group: "Acme" }),
      row("2", "projectGroup.renamed", { from: "Acme", to: "Acme Works" }),
      row("3", "projectGroup.merged", {
        from: "Beta",
        into: "Acme Works",
        count: 2,
      }),
      row("4", "projectGroup.deleted", { group: "Gamma", count: 1 }),
      row("5", "projectGroup.reordered", { group: "Acme Works" }),
      row("6", "project.groupChanged", {
        project: "Kestrel",
        group: "Acme Works",
      }),
      row("7", "project.groupChanged", { project: "Osprey", group: "" }),
    ]);
    expect(text).toContain("Rina created the project group Acme");
    expect(text).toContain("Rina renamed the project group Acme to Acme Works");
    expect(text).toContain(
      "Rina merged the project group Beta into Acme Works (2 projects moved)"
    );
    expect(text).toContain(
      "Rina deleted the project group Gamma (1 project ungrouped)"
    );
    expect(text).toContain("Rina moved the project group Acme Works");
    expect(text).toContain("Rina moved Kestrel to the group Acme Works");
    expect(text).toContain("Rina removed Osprey from its group");
    expect(text).not.toContain("did something");
  });
});

describe("activity page storage events", () => {
  it("renders each environment storage action as a sentence", async () => {
    const text = await renderEvents([
      row("1", "storage.created", {
        name: "Uploads",
        environment: "Kestrel QA",
      }),
      row("2", "storage.updated", {
        name: "Uploads",
        environment: "Kestrel QA",
      }),
      row("3", "storage.deleted", {
        name: "Uploads",
        environment: "Kestrel QA",
      }),
      row("4", "storage.deleted", { name: "Old bucket", environment: "" }),
      row("5", "storage.assigned", {
        name: "Old bucket",
        environment: "Heron QA",
      }),
    ]);
    expect(text).toContain("Rina added the storage Uploads to Kestrel QA");
    expect(text).toContain("Rina updated the storage Uploads of Kestrel QA");
    expect(text).toContain("Rina removed the storage Uploads from Kestrel QA");
    expect(text).toContain("Rina deleted the unassigned storage Old bucket");
    expect(text).toContain("Rina assigned the storage Old bucket to Heron QA");
    expect(text).not.toContain("storage.");
  });
});

describe("activity page backup destination events", () => {
  it("renders the backup destination set and removed", async () => {
    const text = await renderEvents([
      row("1", "instance.backupDestinationChanged", {
        state: "set",
        endpoint: "https://objects.example.test",
        bucket: "fictional-panel-backups",
      }),
      row("2", "instance.backupDestinationChanged", {
        state: "cleared",
        endpoint: "",
        bucket: "",
      }),
    ]);
    expect(text).toContain(
      "Rina set the backup destination to fictional-panel-backups at https://objects.example.test"
    );
    expect(text).toContain(
      "Rina removed the backup destination; backups stay on this server"
    );
    expect(text).not.toContain("instance.");
  });
});
