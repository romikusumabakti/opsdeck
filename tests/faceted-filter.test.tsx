// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FacetedFilter } from "@/components/ui/faceted-filter";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: "open", label: "Open", count: 3 },
  { value: "closed", label: "Closed", count: 1 },
  { value: "draft", label: "Draft", count: 0 },
];

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function Harness({ onChange }: { onChange: (v: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <IntlProvider
      locale="en"
      messages={{ dataTable: { noResults: "No results." } }}
    >
      <FacetedFilter
        title="Status"
        options={OPTIONS}
        selected={selected}
        onChange={(values) => {
          onChange(values);
          setSelected(values);
        }}
      />
    </IntlProvider>
  );
}

const trigger = () =>
  document.querySelector<HTMLElement>('[data-slot="combobox-trigger"]');
const items = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
];
const item = (label: string) => {
  const el = items().find((i) => i.textContent?.includes(label));
  if (!el) throw new Error(`no item ${label}`);
  return el;
};
const popupOpen = () =>
  document.querySelector('[data-slot="combobox-content"]') !== null;

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
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

describe("FacetedFilter", () => {
  it("toggles several values and clears them", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Harness onChange={onChange} />));
    expect(trigger()?.textContent).toContain("Status");
    expect(trigger()?.querySelector('[data-slot="badge"]')).toBeNull();

    await click(trigger() as HTMLElement);
    expect(popupOpen()).toBe(true);
    expect(items().map((i) => i.textContent?.trim())).toEqual([
      "Open3",
      "Closed1",
      "Draft0",
    ]);

    await click(item("Open"));
    expect(onChange).toHaveBeenLastCalledWith(["open"]);
    expect(popupOpen()).toBe(true);

    await click(item("Draft"));
    expect(onChange).toHaveBeenLastCalledWith(["open", "draft"]);
    expect(popupOpen()).toBe(true);
    expect(trigger()?.querySelector('[data-slot="badge"]')?.textContent).toBe(
      "2"
    );

    await click(item("Open"));
    expect(onChange).toHaveBeenLastCalledWith(["draft"]);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(trigger()?.querySelector('[data-slot="badge"]')?.textContent).toBe(
      "1"
    );
  });
});
