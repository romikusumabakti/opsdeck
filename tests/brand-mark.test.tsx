// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BrandLogoView } from "@/components/brand-mark";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LOGO = {
  src: "/brand/logo?v=abc",
  darkSrc: "/brand/logo?theme=dark&v=abc",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(node));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const wrapper = () => container.querySelector<HTMLElement>(".brand-logo");
const status = () =>
  container.querySelector<HTMLElement>("[data-slot='brand-activity']");

describe("BrandLogoView", () => {
  it("renders the default tile mark when no logo is set, with the tile pulse when active", () => {
    render(<BrandLogoView logo={null} active runsLabel="Runs in progress" />);
    expect(container.querySelectorAll("path.brand-tile")).toHaveLength(4);
    expect(container.querySelector("path.brand-tile-br")?.classList).toContain(
      "fill-(--logo-status)"
    );
    expect(container.querySelector("img")).toBeNull();
    expect(wrapper()?.hasAttribute("data-active")).toBe(true);
    // The tile itself pulses: no extra dot on the built-in mark.
    expect(status()).toBeNull();
  });

  it("renders an uploaded logo as-is with its dark variant", () => {
    render(<BrandLogoView logo={LOGO} />);
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe(LOGO.src);
    expect(images[0]?.classList).toContain("dark:hidden");
    expect(images[1]?.getAttribute("src")).toBe(LOGO.darkSrc);
    expect(images[1]?.classList).toContain("dark:block");
    for (const image of images) {
      expect(image.getAttribute("alt")).toBe("");
      expect(image.className).not.toContain("fill-(--logo)");
    }
    expect(container.querySelector("path.brand-tile")).toBeNull();

    // No dark variant: one image, shown in both themes.
    act(() => root.render(<BrandLogoView logo={{ ...LOGO, darkSrc: null }} />));
    const single = container.querySelectorAll("img");
    expect(single).toHaveLength(1);
    expect(single[0]?.classList).not.toContain("dark:hidden");
  });

  it("shows a labelled pulsing dot for active runs on an uploaded logo", () => {
    render(<BrandLogoView logo={LOGO} active runsLabel="Runs in progress" />);
    const dot = status();
    expect(dot?.getAttribute("role")).toBe("status");
    expect(dot?.getAttribute("aria-label")).toBe("Runs in progress");
    expect(wrapper()?.hasAttribute("data-active")).toBe(true);
  });

  it("no dot when idle", () => {
    render(<BrandLogoView logo={LOGO} runsLabel="Runs in progress" />);
    expect(status()).toBeNull();
    expect(wrapper()?.hasAttribute("data-active")).toBe(false);
  });
});
