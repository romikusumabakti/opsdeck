// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/components/search-select";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const OPTIONS: SearchSelectOption[] = [
  { value: "s1", label: "app-alpha", hint: "192.0.2.10" },
  { value: "s2", label: "db-bravo", hint: "198.51.100.129" },
  { value: "s3", label: "edge-charlie", keywords: "42" },
];

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const trigger = () =>
  container.querySelector<HTMLElement>('[data-slot="combobox-trigger"]');
const input = () =>
  document.querySelector<HTMLInputElement>('[data-slot="input-group-control"]');
const itemEls = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
];

async function open() {
  await act(async () => trigger()?.click());
  await settle();
}

async function type(text: string) {
  const el = input() as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(el, text);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
  });
  await settle();
}

type Props = Parameters<typeof SearchSelect>[0];

async function render(props: Partial<Props> = {}) {
  const all: Props = {
    value: null,
    onChange: vi.fn(),
    options: OPTIONS,
    placeholder: "Pick one",
    ...props,
  };
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <SearchSelect {...all} />
      </IntlProvider>
    )
  );
  await settle();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("SearchSelect", () => {
  it("shows the placeholder, then the picked label with its hint", async () => {
    await render();
    expect(trigger()?.textContent).toContain("Pick one");
    await render({ value: "s2" });
    expect(trigger()?.textContent).toContain("db-bravo");
    expect(trigger()?.textContent).toContain("198.51.100.129");
  });

  it("shows the placeholder for a value with no matching option", async () => {
    await render({ value: "0190a0b2-gone" });
    expect(trigger()?.textContent).toContain("Pick one");
    expect(trigger()?.textContent).not.toContain("0190a0b2-gone");
  });

  it("finds an option by part of its hint", async () => {
    await render();
    await open();
    await type("100.129");
    const items = itemEls();
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("db-bravo");
  });

  it("finds an option by part of its label, case-insensitively", async () => {
    await render();
    await open();
    await type("ALPH");
    const items = itemEls();
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("app-alpha");
  });

  it("finds an option by its keywords", async () => {
    await render();
    await open();
    await type("42");
    expect(itemEls().map((el) => el.textContent)).toEqual([
      expect.stringContaining("edge-charlie"),
    ]);
  });

  it("shows the empty text when nothing matches", async () => {
    await render();
    await open();
    await type("zzz");
    expect(itemEls()).toHaveLength(0);
    expect(document.body.textContent).toContain(messages.common.noResults);
  });

  it("reports the picked value", async () => {
    const onChange = vi.fn();
    await render({ onChange });
    await open();
    const bravo = itemEls().find((el) => el.textContent?.includes("db-bravo"));
    await act(async () => bravo?.click());
    await settle();
    expect(onChange).toHaveBeenLastCalledWith("s2");
  });

  it("lists every option when opened with a value picked", async () => {
    await render({ value: "s2" });
    await open();
    expect(input()?.value).toBe("");
    expect(itemEls()).toHaveLength(OPTIONS.length);
  });

  it("keeps a disabled option listed but not pickable", async () => {
    const onChange = vi.fn();
    await render({
      onChange,
      options: [{ value: "x", label: "taken-one", disabled: true }],
    });
    await open();
    await act(async () => itemEls()[0]?.click());
    await settle();
    expect(itemEls()[0]?.hasAttribute("data-disabled")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers the none item first and reports null", async () => {
    const onChange = vi.fn();
    await render({ noneLabel: "No parent", value: "s1", onChange });
    await open();
    expect(itemEls()[0]?.textContent).toContain("No parent");
    await act(async () => itemEls()[0]?.click());
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("shows the none label in the trigger when the value is null", async () => {
    await render({ noneLabel: "No parent" });
    expect(trigger()?.textContent).toContain("No parent");
  });

  it("puts triggerProps, id and aria attributes on the trigger", async () => {
    await render({
      id: "pick",
      invalid: true,
      "aria-label": "Server",
      triggerProps: { "data-server-select": "" },
    });
    const el = container.querySelector<HTMLElement>("[data-server-select]");
    expect(el).toBe(trigger());
    expect(el?.id).toBe("pick");
    expect(el?.getAttribute("aria-invalid")).toBe("true");
    expect(el?.getAttribute("aria-label")).toBe("Server");
  });
});
