// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const state = vi.hoisted(() => ({ role: "staff" }));

// Two projects exist and the caller is a member of both, as after a role
// change from qa to staff that left the memberships behind.
vi.mock("@/lib/db", () => {
  const rows = [{ id: "p1", projectId: "p1" }];
  const chain: Record<string, unknown> = {};
  chain.from = () => Object.assign(Promise.resolve(rows), chain);
  chain.where = () => Object.assign(Promise.resolve(rows), chain);
  chain.orderBy = async () => [{ id: "p1", name: "One", key: "ONE" }];
  return { db: { select: () => chain } };
});
vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: "u1", role: state.role } }),
}));
vi.mock("@/server/context", () => ({
  requestCache: <T,>(fn: T) => fn,
  getLocale: () => "en",
}));

import { listIssueProjects } from "@/lib/home/queries";
import { HomeIssueDialogProvider } from "@/web/routes/$locale/_app/-components/home/home-issue-dialog";
import { NewIssueButton } from "@/web/routes/$locale/_app/-components/home/new-issue-button";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderButton(
  projects: { id: string; name: string; key: string }[]
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <HomeIssueDialogProvider projects={projects} defaultTarget={null}>
          <NewIssueButton />
        </HomeIssueDialogProvider>
      </IntlProvider>
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Home for staff", () => {
  it("offers no project to file an issue in, even with a membership row", async () => {
    state.role = "staff";
    const projects = await listIssueProjects();
    expect(projects).toEqual([]);
    await renderButton(projects);
    expect(container.querySelector("button")).toBeNull();
  });

  it("lists the project for a qa with the same membership (control)", async () => {
    state.role = "qa";
    expect((await listIssueProjects()).map((p) => p.id)).toEqual(["p1"]);
  });

  it("shows New issue when a project is writable (control)", async () => {
    await renderButton([{ id: "p1", name: "One", key: "ONE" }]);
    expect(container.querySelector("button")?.textContent).toContain(
      messages.homePage.newIssue
    );
  });
});
