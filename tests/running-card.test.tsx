// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { getEnvironmentRunningQuery } from "@/web/api/environments";
import messages from "../messages/en.json";
import { RunningCard } from "../web/routes/$locale/_app/-components/env/running-card";

// The dashboard's Running card: per deploy target its tag, short commit and
// when it was deployed; "Not deployed" and "Unknown commit" otherwise.

const ENV = "e1";
const SHA = "0123456789abcdef0123456789abcdef01234567";

let root: Root;
let container: HTMLDivElement;

async function mount(items: unknown[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(getEnvironmentRunningQuery(ENV).queryKey, {
    items,
  } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="UTC"
          now={new Date("2026-11-10T10:03:00Z")}
        >
          <RunningCard environmentId={ENV} />
        </IntlProvider>
      </QueryClientProvider>
    )
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const row = (key: string) =>
  [...container.querySelectorAll("li")].find((li) =>
    li.textContent?.includes(key)
  );

describe("RunningCard", () => {
  it("shows the tag, the 7-character commit and the relative deploy time", async () => {
    await mount([
      {
        componentKey: "api",
        repoFullName: "acme/api",
        commitSha: SHA,
        tag: "v1.4.0",
        ref: SHA,
        deployed: true,
        deployedAt: "2026-11-10T08:03:00.000Z",
      },
    ]);
    expect(container.textContent).toContain("Running");
    const api = row("api");
    expect(api?.textContent).toContain("acme/api");
    expect(api?.textContent).toContain("v1.4.0");
    const sha = api?.querySelector("code");
    expect(sha?.textContent).toBe("0123456");
    expect(sha?.className).toContain("font-mono");
    expect(api?.querySelector("time")?.textContent).toBe("2 hours ago");
  });

  it("marks a never-deployed target and a deployment whose commit is unknown", async () => {
    await mount([
      {
        componentKey: "web",
        repoFullName: "acme/web",
        commitSha: null,
        tag: null,
        ref: "develop",
        deployed: false,
        deployedAt: null,
      },
      {
        componentKey: "worker",
        repoFullName: "acme/worker",
        commitSha: null,
        tag: "v0.9.0",
        ref: "main",
        deployed: true,
        deployedAt: "2026-11-09T10:03:00.000Z",
      },
    ]);
    const web = row("web");
    expect(web?.textContent).toContain("Not deployed");
    expect(web?.querySelector("time")).toBeNull();
    const worker = row("worker");
    expect(worker?.textContent).toContain("v0.9.0");
    expect(worker?.textContent).toContain("Unknown commit");
    expect(worker?.textContent).not.toContain("Not deployed");
  });

  it("renders nothing when the environment has no deploy targets", async () => {
    await mount([]);
    expect(container.textContent).toBe("");
  });
});
