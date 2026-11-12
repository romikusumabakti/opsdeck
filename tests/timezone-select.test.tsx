// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimezoneSelect } from "@/components/user/timezone-select";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const input = () =>
  document.querySelector<HTMLInputElement>('[data-slot="input-group-control"]');
const itemEls = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
];

async function open() {
  await act(async () => {
    container.querySelector<HTMLElement>("button")?.click();
  });
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

async function render(onChange: (zone: string | null) => void) {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <TimezoneSelect
          value="Asia/Jakarta"
          defaultZone="Asia/Jakarta"
          onChange={onChange}
        />
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

describe("TimezoneSelect", () => {
  it("picks the default as null", async () => {
    const onChange = vi.fn();
    await render(onChange);
    await open();

    expect(itemEls()[0]?.textContent).toContain("Organisation default");
    await act(async () => itemEls()[0]?.click());
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(null);

    await open();
    await type("tokyo");
    const tokyo = itemEls();
    expect(tokyo).toHaveLength(1);
    expect(tokyo[0]?.textContent?.trim()).toBe("Asia/Tokyo");
    await act(async () => tokyo[0]?.click());
    await settle();
    expect(onChange).toHaveBeenLastCalledWith("Asia/Tokyo");
  });

  it("displays underscores as spaces", async () => {
    await render(vi.fn());
    await open();
    await type("new_york");
    expect(itemEls().map((el) => el.textContent?.trim())).toContain(
      "America/New York"
    );
  });
});
