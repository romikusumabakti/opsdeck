// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ pathname: "/projects" }));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => nav.pathname,
}));

import {
  ASSISTANT_COMPOSER_ID,
  AssistantShortcut,
  assistantShortcutLabel,
} from "@/web/components/assistant/assistant-shortcut";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<AssistantShortcut />));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  push.mockClear();
  nav.pathname = "/projects";
});

/** Presses a key on `target`; returns the event to read defaultPrevented. */
function press(
  target: EventTarget,
  init: KeyboardEventInit = { key: "j", ctrlKey: true }
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Ctrl/Cmd+J opens the assistant", () => {
  it("navigates from a plain page and claims the key", () => {
    const event = press(document.body);
    expect(push).toHaveBeenCalledExactlyOnceWith("/assistant");
    expect(event.defaultPrevented).toBe(true);
  });

  it("works with Cmd on a Mac and with caps lock on", () => {
    press(document.body, { key: "j", metaKey: true });
    press(document.body, { key: "J", ctrlKey: true });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("works from a plain text field", () => {
    const input = document.createElement("input");
    document.body.append(input);
    press(input);
    expect(push).toHaveBeenCalledWith("/assistant");
  });

  it("does nothing inside a contenteditable (the rich-text editor)", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    editor.append(paragraph);
    document.body.append(editor);
    const event = press(paragraph);
    expect(push).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing when another handler already claimed the key", () => {
    const field = document.createElement("div");
    field.addEventListener("keydown", (e) => e.preventDefault());
    document.body.append(field);
    press(field);
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores other chords", () => {
    press(document.body, { key: "j", ctrlKey: true, shiftKey: true });
    press(document.body, { key: "j", ctrlKey: true, altKey: true });
    press(document.body, { key: "j" });
    press(document.body, { key: "k", ctrlKey: true });
    expect(push).not.toHaveBeenCalled();
  });

  it("on the assistant page focuses the question box instead", async () => {
    nav.pathname = "/assistant";
    await act(async () => root.render(<AssistantShortcut key="again" />));
    const box = document.createElement("textarea");
    box.id = ASSISTANT_COMPOSER_ID;
    document.body.append(box);
    press(document.body);
    expect(push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box);
  });
});

describe("the shortcut's label", () => {
  it("reads like the palette's: ⌘J on a Mac, Ctrl J elsewhere", () => {
    expect(assistantShortcutLabel("⌘")).toBe("⌘J");
    expect(assistantShortcutLabel("Ctrl")).toBe("Ctrl J");
  });
});

describe("the issues table's j/k keys", () => {
  it("leave modified chords (Ctrl/Cmd+J) to other handlers", () => {
    const source = readFileSync(
      "web/routes/$locale/_app/-components/issues-client.tsx",
      "utf8"
    );
    const handler = source.slice(source.indexOf("function onKey("));
    expect(handler).toMatch(
      /^function onKey\([^)]*\) \{[\s\S]*?if \(e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return;[\s\S]*?e\.key === "j"/
    );
  });
});
