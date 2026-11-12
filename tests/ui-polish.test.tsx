// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { CopyButton } from "@/components/copy-button";
import messages from "../messages/en.json";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const APP = "web/routes/$locale/_app";
const src = (path: string) => readFileSync(path, "utf8");
const attentionList = `${APP}/-components/home/attention-list.tsx`;
const recentEnvs = `${APP}/-components/home/recent-envs-section.tsx`;
const backupButton = `${APP}/-components/home/backup-button.tsx`;
const bell = "components/notification-bell.tsx";
const activeRuns = "components/active-runs-indicator.tsx";

function renderCopyButton(variant?: "ghost" | "outline") {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <CopyButton value="x" variant={variant} />
      </IntlProvider>
    );
  });
  const button = host.querySelector("button");
  if (!button) throw new Error("no button rendered");
  const className = button.className;
  act(() => root.unmount());
  host.remove();
  return className;
}

describe("copy button", () => {
  it("CopyButton keeps the muted ghost look by default", () => {
    expect(renderCopyButton()).toContain("text-muted-foreground");
  });
  it("CopyButton outline matches its toolbar neighbours", () => {
    const cls = renderCopyButton("outline");
    expect(cls).toContain("border-border");
    expect(cls).not.toContain("text-muted-foreground");
  });
  it("the log toolbar uses the outline copy button", () => {
    expect(src("components/log-viewer.tsx")).toMatch(
      /<CopyButton[^>]*variant="outline"/
    );
  });
});

describe("hover polish", () => {
  it("hoverable rows share one tone", () => {
    for (const f of [
      attentionList,
      recentEnvs,
      backupButton,
      bell,
      activeRuns,
    ]) {
      expect(src(f)).not.toContain("hover:bg-accent");
    }
    for (const f of [attentionList, recentEnvs, bell]) {
      expect(src(f)).toContain("hover:bg-muted/40");
    }
  });
  it("ghost buttons in hoverable rows hover at full strength", () => {
    for (const f of [attentionList, backupButton, bell]) {
      expect(src(f)).toContain("dark:hover:bg-muted");
    }
  });
  it("header-plus-list popovers have no gap", () => {
    for (const f of [bell, activeRuns]) {
      expect(src(f)).toContain("gap-0 p-0");
    }
  });
});

describe("settings width", () => {
  it("settings pages are max-w-4xl", () => {
    for (const f of [
      `${APP}/$projectKey.settings.tsx`,
      `${APP}/-components/env/settings/settings-tabs.tsx`,
      `${APP}/-components/env/skeletons.tsx`,
    ]) {
      expect(src(f)).not.toContain("max-w-2xl");
      expect(src(f)).toContain("max-w-4xl");
    }
  });
});

describe("users table", () => {
  it("the users table starts sorted by name", () => {
    const s = src(`${APP}/-components/admin/users/users-table.tsx`);
    expect(s).toContain('{ id: "name", desc: false }');
    expect(s).toContain("initialSorting=");
  });
});
