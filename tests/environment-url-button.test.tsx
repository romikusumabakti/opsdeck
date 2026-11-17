// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentUrlButton } from "@/components/nav/environment-url";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import messages from "../messages/en.json";

// The environment's web address: an icon link beside a name, or, with a
// label, the dashboard header's "Open app" button. Only http(s) URLs.

let root: Root;
let container: HTMLDivElement;

async function mount(url: string | null, label?: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <EnvironmentUrlButton url={url} label={label} />
      </IntlProvider>
    )
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("EnvironmentUrlButton", () => {
  it("with a label renders a small outline link button that opens a new tab", async () => {
    await mount("https://app.example.invalid", "Open app");
    const a = container.querySelector("a");
    expect(a?.textContent).toBe("Open app");
    expect(a?.getAttribute("href")).toBe("https://app.example.invalid");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    // The visible label is the accessible name.
    expect(a?.hasAttribute("aria-label")).toBe(false);
    for (const c of cn(
      buttonVariants({ variant: "outline", size: "sm" })
    ).split(" "))
      expect(a?.classList.contains(c)).toBe(true);
  });

  it("without a label stays the icon link", async () => {
    await mount("https://app.example.invalid");
    const a = container.querySelector("a");
    expect(a?.textContent).toBe("");
    expect(a?.getAttribute("aria-label")).toContain(
      "https://app.example.invalid"
    );
  });

  it.each([null, "javascript:alert(1)"])(
    "renders nothing for %s",
    async (url) => {
      await mount(url, "Open app");
      expect(container.querySelector("a")).toBeNull();
    }
  );
});
