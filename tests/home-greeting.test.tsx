// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  companyName: null,
  allowedEmailDomain: "example.com",
});

const session = vi.hoisted(() => ({
  me: {
    user: {
      name: "Dana Putri Lestari",
      preferredName: "Dana" as string | null,
    },
    timeZone: "UTC",
  },
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => session.me,
  useBootstrap: () => ({ appTimeZone: "UTC" }),
}));

import { HomeHeader } from "@/web/routes/$locale/_app/-components/home/home-header";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T08:00:00Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <HomeHeader action={<button type="button">New issue</button>} />
      </IntlProvider>
    )
  );
}

describe("HomeHeader", () => {
  it("greets by the preferred name, calmly, without the assistant's icon", () => {
    render();
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe("Good morning, Dana");
    expect(h1?.textContent).not.toContain("!");
    // The robot icon means the Assistant (the sidebar's): not the greeting.
    expect(container.querySelector("svg")).toBeNull();
    // No subtitle under the greeting.
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).not.toContain(
      "Your work and what needs attention."
    );
    expect(container.querySelector("button")?.textContent).toBe("New issue");
    expect(enMessages.homePage).not.toHaveProperty("subtitle");
  });

  it("falls back to the full display name", () => {
    session.me.user.preferredName = null;
    render();
    expect(container.querySelector("h1")?.textContent).toBe(
      "Good morning, Dana Putri Lestari"
    );
  });
});
