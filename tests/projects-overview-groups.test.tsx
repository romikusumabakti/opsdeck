// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// The Projects page's grouped layout: sections in group rank order with
// "No group" last, a plain grid for zero or one group, a group filter, search
// by group name, and per-user collapsed sections.

vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects",
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

import { ProjectsOverview } from "@/components/projects-overview";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const group = (id: string, name: string, rank: string) => ({
  id,
  name,
  rank,
  projectCount: 1,
});
const GROUPS = [
  group("g-b", "Bravo", "a0"),
  group("g-a", "Alpha", "a1"),
  group("g-c", "Charlie", "a2"),
];

const project = (key: string, groupId: string | null) =>
  ({
    id: `p-${key}`,
    key,
    name: `Proj ${key}`,
    groupId,
    client: null,
    environments: [],
  }) as never;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(
  projects: unknown[],
  groups: typeof GROUPS,
  userId = "u1"
) {
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <ProjectsOverview
          projects={projects as never}
          groups={groups}
          userId={userId}
          openIssueCounts={{}}
          lastActivity={{}}
          lastOpened={{}}
          initialSort="name_asc"
          projectRoles={{}}
        />
      </IntlProvider>
    );
  });
}

const headings = () =>
  [...container.querySelectorAll("h2")].map((h) => h.textContent ?? "");
const cards = () =>
  [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ProjectsOverview groups", () => {
  it("renders the plain grid with no groups", async () => {
    await render([project("AAA", null), project("BBB", null)], []);
    expect(headings()).toEqual([]);
    expect(container.textContent).toContain("Proj AAA");
    expect(container.textContent).toContain("Proj BBB");
  });

  it("renders the plain grid with one group, without a group filter", async () => {
    await render(
      [project("AAA", "g-a"), project("BBB", "g-a")],
      GROUPS.slice(1, 2)
    );
    expect(headings()).toEqual([]);
    expect(container.textContent).not.toContain("Group");
  });

  it("renders sections in group rank order with No group last", async () => {
    await render(
      [
        project("AAA", null),
        project("BBB", "g-a"),
        project("CCC", "g-b"),
        project("DDD", "g-b"),
      ],
      GROUPS
    );
    expect(headings()).toEqual(["Bravo2", "Alpha1", "No group1"]);
  });

  it("omits sections with no project and No group when everything is grouped", async () => {
    await render([project("BBB", "g-a"), project("CCC", "g-b")], GROUPS);
    expect(headings()).toEqual(["Bravo1", "Alpha1"]);
  });

  it("collapses a section, remembers it per user", async () => {
    const projects = [project("BBB", "g-a"), project("CCC", "g-b")];
    await render(projects, GROUPS, "u1");
    const toggle = () =>
      container.querySelector<HTMLButtonElement>("h2 button");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Proj CCC");
    expect(container.textContent).toContain("Proj BBB");

    // Same user after a reload: still collapsed.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(projects, GROUPS, "u1");
    expect(container.textContent).not.toContain("Proj CCC");

    // Another user starts expanded.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(projects, GROUPS, "u2");
    expect(container.textContent).toContain("Proj CCC");
  });

  it("expands collapsed sections while searching", async () => {
    await render([project("BBB", "g-a"), project("CCC", "g-b")], GROUPS);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("h2 button")?.click()
    );
    expect(container.textContent).not.toContain("Proj CCC");
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "ccc");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Proj CCC");
  });

  it("ignores section toggles while searching", async () => {
    await render([project("BBB", "g-a"), project("CCC", "g-b")], GROUPS);
    const input = container.querySelector("input") as HTMLInputElement;
    const type = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("proj");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("h2 button")?.click()
    );
    expect(localStorage.getItem("menara:projects:collapsed-groups:u1")).toBe(
      null
    );
    await type("");
    expect(container.textContent).toContain("Proj CCC");
    expect(container.textContent).toContain("Proj BBB");
  });

  it("names the group on the card in the plain grid only", async () => {
    await render(
      [project("AAA", "g-a"), project("BBB", null)],
      GROUPS.slice(1, 2)
    );
    expect(container.textContent).toContain("· Alpha");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render([project("BBB", "g-a"), project("CCC", "g-b")], GROUPS);
    expect(container.textContent).not.toContain("· Alpha");
    expect(container.textContent).not.toContain("· Bravo");
  });

  it("matches the group name in search", async () => {
    await render(
      [project("BBB", "g-a"), project("CCC", "g-b"), project("DDD", null)],
      GROUPS
    );
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "alph");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(headings()).toEqual(["Alpha1"]);
    expect(cards()).toEqual(["/BBB"]);
  });

  it("filters by group, including No group", async () => {
    await render(
      [project("BBB", "g-a"), project("CCC", "g-b"), project("DDD", null)],
      GROUPS
    );
    const trigger = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Group")
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    const option = (label: string) =>
      [...document.querySelectorAll('[role="option"]')].find((o) =>
        o.textContent?.includes(label)
      ) as HTMLElement;
    await act(async () => option("No group").click());
    expect(headings()).toEqual(["No group1"]);
    expect(container.textContent).toContain("Proj DDD");
    expect(container.textContent).not.toContain("Proj BBB");
  });
});
