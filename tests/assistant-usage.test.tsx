// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import { locales } from "@/i18n/locales";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  allowedEmailDomain: "example.com",
});

const nav = vi.hoisted(() => ({
  search: {} as { tab?: string },
  replace: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => nav.search,
  }),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  Link: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const allowanceFetch = vi.hoisted(() => ({
  current: (() => new Promise(() => {})) as () => Promise<unknown>,
}));
vi.mock("@/web/api/assistant", () => ({
  getAllowanceQuery: () => ({
    queryKey: ["assistant", "getAllowance"],
    queryFn: () => allowanceFetch.current(),
  }),
}));
vi.mock("@/web/api/profile", () => ({
  getAccountQuery: () => ({
    queryKey: ["profile", "getAccount"],
    queryFn: () => new Promise(() => {}),
  }),
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ user: { id: "u1", name: "Ayu Lestari" } }),
  useBootstrap: () => ({ appTimeZone: "UTC" }),
}));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/components/notifications-toggle", () => ({
  NotificationsToggle: () => null,
}));
vi.mock(
  "@/web/routes/$locale/_app/-components/account/change-password-form",
  () => ({ ChangePasswordForm: () => null })
);
vi.mock("@/web/routes/$locale/_app/-components/account/passkeys-list", () => ({
  PasskeysList: () => null,
}));
vi.mock("@/web/routes/$locale/_app/-components/account/profile-form", () => ({
  ProfileForm: () => null,
}));
vi.mock("@/web/routes/$locale/_app/-components/account/sessions-list", () => ({
  SessionsList: () => null,
}));
vi.mock(
  "@/web/routes/$locale/_app/-components/account/two-factor-card",
  () => ({ TwoFactorCard: () => null })
);

import {
  AllowanceBadge,
  allowanceMeter,
} from "@/web/components/assistant/allowance-badge";
import { Route } from "@/web/routes/$locale/_app/account.index";

const t = enMessages.assistant;
const ta = enMessages.account;

const allowance = {
  enabled: true,
  usedFraction: 0.4,
  capReached: false,
  // Midnight in Asia/Jakarta.
  resetsAt: "2026-11-16T17:00:00.000Z",
  readsImages: true,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["profile", "getAccount"], {
    hasPassword: true,
    hasMicrosoftAccount: false,
  });
  nav.search = {};
  nav.replace.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage(
  data: object | null,
  fetchAllowance?: () => Promise<unknown>
) {
  if (data) queryClient.setQueryData(["assistant", "getAllowance"], data);
  allowanceFetch.current = fetchAllowance ?? (() => new Promise(() => {}));
  const Page = (Route as unknown as { options: { component: React.FC } })
    .options.component;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="Asia/Jakarta"
          now={new Date("2026-11-16T05:00:00Z")}
        >
          <Page />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

const text = () => container.textContent ?? "";
const usageTab = () =>
  [...container.querySelectorAll('[role="tab"]')].find((el) =>
    el.textContent?.includes(ta.tabs.usage)
  );

describe("the Usage tab in Account", () => {
  it("is hidden when the assistant is disabled", async () => {
    await renderPage({ ...allowance, enabled: false });
    expect(usageTab()).toBeUndefined();
  });

  it("is hidden, and ?tab=usage falls back to Profile, when disabled", async () => {
    nav.search = { tab: "usage" };
    await renderPage({ ...allowance, enabled: false });
    expect(usageTab()).toBeUndefined();
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toContain(ta.tabs.profile);
  });

  it("shows used, left and the reset time, without dollars", async () => {
    nav.search = { tab: "usage" };
    await renderPage(allowance);
    expect(usageTab()).toBeDefined();
    expect(text()).toContain("40% used today · 60% left");
    expect(text()).toMatch(/Resets (12:00|00:00)/);
    expect(text()).toContain(ta.usage.note);
    expect(text()).not.toMatch(/\$|USD/);
    expect(
      container
        .querySelector("[role=progressbar]")
        ?.getAttribute("aria-valuenow")
    ).toBe("40");
    expect(text()).not.toContain(ta.usage.capReached);
  });

  it("at the cap shows 100% used, 0% left and the paused line", async () => {
    nav.search = { tab: "usage" };
    await renderPage({ ...allowance, usedFraction: 1, capReached: true });
    expect(text()).toContain("100% used today · 0% left");
    expect(text()).toContain(ta.usage.capReached);
    expect(
      container.querySelector("[data-slot=progress]")?.className
    ).toContain("destructive");
  });

  it("rounds like the badge: used down, so 99.96% reads 99% used, 1% left", async () => {
    nav.search = { tab: "usage" };
    await renderPage({ ...allowance, usedFraction: 0.9996 });
    expect(text()).toContain("99% used today · 1% left");
    expect(text()).not.toContain(ta.usage.capReached);
    expect(allowanceMeter({ ...allowance, usedFraction: 0.9996 }).percent).toBe(
      99
    );
  });

  it("turns amber from 80% used", async () => {
    nav.search = { tab: "usage" };
    await renderPage({ ...allowance, usedFraction: 0.8 });
    expect(
      container.querySelector("[data-slot=progress]")?.className
    ).toContain("amber");
  });
});

describe("when the allowance can't load", () => {
  it("Account still renders Profile if the allowance request fails", async () => {
    await renderPage(null, () => Promise.reject(new Error("boom")));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(usageTab()).toBeUndefined();
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toContain(ta.tabs.profile);
  });

  it("a cold ?tab=usage lands on Usage once the allowance arrives", async () => {
    nav.search = { tab: "usage" };
    await renderPage(null, () => Promise.resolve(allowance));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toContain(ta.tabs.usage);
    expect(text()).toContain("40% used today");
  });

  it("a failed allowance with ?tab=usage falls back to Profile", async () => {
    nav.search = { tab: "usage" };
    await renderPage(null, () => Promise.reject(new Error("boom")));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toContain(ta.tabs.profile);
  });

  it("switching tabs puts the tab in the URL with replace", async () => {
    await renderPage(allowance);
    await act(async () => {
      (usageTab() as HTMLElement).click();
    });
    expect(nav.replace).toHaveBeenCalledWith("/account?tab=usage");
  });
});

describe("links to the Usage tab", () => {
  it("the toolbar badge links to /account?tab=usage", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="Asia/Jakarta"
          now={new Date("2026-11-16T05:00:00Z")}
        >
          <AllowanceBadge allowance={{ ...allowance, usedFraction: 0.85 }} />
        </IntlProvider>
      );
    });
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/account?tab=usage");
    expect(text()).toContain("85% of today's limit used");
  });

  it("the badge stays a link at the cap; the cap is announced beside it", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="Asia/Jakarta"
          now={new Date("2026-11-16T05:00:00Z")}
        >
          <AllowanceBadge
            allowance={{ ...allowance, usedFraction: 1, capReached: true }}
          />
        </IntlProvider>
      );
    });
    const link = container.querySelector("a");
    expect(link?.getAttribute("role")).toBeNull();
    expect(link?.querySelector("[role=status]")).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toContain(
      "reached today's limit"
    );
  });
});

describe("messages", () => {
  it.each(locales)("%s has the Usage strings", async (locale) => {
    const m = (await import(`../messages/${locale}.json`)).default;
    for (const key of Object.keys(enMessages.account.usage)) {
      expect(
        (m.account.usage as Record<string, string>)[key]?.length
      ).toBeGreaterThan(0);
    }
    expect(m.account.tabs.usage.length).toBeGreaterThan(0);
    expect(m.assistant.usageMenu.length).toBeGreaterThan(0);
  });
  it("t.usageMenu exists in en", () => {
    expect(t.usageMenu).toBe("Usage");
  });
});
