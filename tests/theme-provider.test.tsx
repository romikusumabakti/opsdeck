// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "@/components/theme-provider";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let current: ReturnType<typeof useTheme>;
let osDark = false;
let listeners: Array<() => void> = [];

function stubMatchMedia() {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return osDark;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  })) as unknown as typeof window.matchMedia;
}

function Probe() {
  current = useTheme();
  return null;
}

function mount() {
  act(() => {
    root.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
  });
}

const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  html().className = "";
  html().style.colorScheme = "";
  osDark = false;
  listeners = [];
  stubMatchMedia();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ThemeProvider", () => {
  it("applies a saved dark theme", () => {
    localStorage.setItem("theme", "dark");
    mount();
    expect(current.theme).toBe("dark");
    expect(current.resolvedTheme).toBe("dark");
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().style.colorScheme).toBe("dark");
  });

  it("falls back to system for an unknown stored value", () => {
    localStorage.setItem("theme", "blue");
    osDark = true;
    mount();
    expect(current.theme).toBe("system");
    expect(current.resolvedTheme).toBe("dark");
  });

  it("follows the OS while on system", () => {
    mount();
    expect(current.resolvedTheme).toBe("light");
    expect(html().classList.contains("dark")).toBe(false);
    osDark = true;
    act(() => {
      for (const l of listeners) l();
    });
    expect(current.resolvedTheme).toBe("dark");
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("setTheme persists and applies", () => {
    localStorage.setItem("theme", "dark");
    mount();
    act(() => current.setTheme("light"));
    expect(localStorage.getItem("theme")).toBe("light");
    expect(html().classList.contains("dark")).toBe(false);
    expect(html().style.colorScheme).toBe("light");
  });
});
