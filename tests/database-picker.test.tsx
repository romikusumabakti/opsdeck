// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabasePicker } from "@/components/database-picker";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DATABASES = [
  { name: "dplk", isDefault: true },
  { name: "dppk", isDefault: false },
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

function picker(value: string, onChange: (v: string) => void) {
  return (
    <DatabasePicker
      id="db"
      databases={DATABASES}
      value={value}
      onChange={onChange}
      defaultSuffix="(default)"
      placeholder="Pick a database"
      searchPlaceholder="Search databases"
      emptyText="No database"
    />
  );
}

const trigger = () => document.getElementById("db") as HTMLElement;
const input = () =>
  document.querySelector<HTMLInputElement>('[data-slot="input-group-control"]');
const items = () =>
  [...document.querySelectorAll('[data-slot="combobox-item"]')].map((el) =>
    el.textContent?.trim()
  );

async function openPicker() {
  await act(async () => {
    trigger().click();
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

async function press(key: string) {
  await act(async () => {
    (input() as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
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

describe("DatabasePicker", () => {
  it("filters and picks a database", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(picker("", onChange)));
    expect(trigger().textContent).toContain("Pick a database");

    await openPicker();
    expect(input()).not.toBeNull();

    await type("dp");
    expect(items()).toHaveLength(2);
    await type("dpp");
    expect(items()).toEqual(["dppk"]);

    await press("Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("dppk");
    expect(input()).toBeNull();
  });

  it("shows the default suffix on the selected value", async () => {
    await act(async () => root.render(picker("dplk", vi.fn())));
    expect(trigger().textContent).toContain("dplk (default)");
  });

  it("Escape inside a dialog closes only the picker", async () => {
    const onOpenChange = vi.fn();
    await act(async () =>
      root.render(
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Restore</DialogTitle>
            {picker("", vi.fn())}
          </DialogContent>
        </Dialog>
      )
    );
    await settle();
    await openPicker();
    expect(input()).not.toBeNull();

    await press("Escape");
    expect(input()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-slot="dialog-content"]')
    ).not.toBeNull();

    // The picker is closed, so the next Escape reaches the dialog.
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});
