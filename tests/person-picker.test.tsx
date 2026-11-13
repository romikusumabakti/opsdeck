// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Person, PersonPicker } from "@/components/person-picker";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const PEOPLE: Person[] = [
  { id: "u1", name: "Rina", image: null, email: "rina@acme.test" },
  { id: "u2", name: "Wella", image: null, email: "wella@acme.test" },
  {
    id: "u3",
    name: "Dede",
    image: null,
    email: "dede@acme.test",
    banned: true,
  },
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
  await act(async () => {
    trigger()?.click();
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

type Props = Parameters<typeof PersonPicker>[0];

// Props are loose here: a test may switch to action mode by passing
// `actionLabel` together with `value: undefined`.
async function render(props: Record<string, unknown> = {}) {
  const all = { people: PEOPLE, value: null, onChange: vi.fn(), ...props };
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <PersonPicker {...(all as Props)} />
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

describe("PersonPicker", () => {
  it("marks a deactivated current person in the trigger and keeps the status tooltip", async () => {
    await render({
      people: [
        {
          id: "u3",
          name: "Dede",
          image: null,
          banned: true,
          status: { emoji: "🌴", text: "On leave" },
        },
      ],
      value: "u3",
    });
    expect(trigger()?.textContent).toContain("Dede (Deactivated)");
    expect(trigger()?.querySelector('[title="On leave"]')?.textContent).toBe(
      "🌴"
    );
  });

  it("finds a person by email, case-insensitively", async () => {
    await render();
    await open();
    await type("WELLA@");
    const items = itemEls();
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("Wella");
  });

  it("shows the empty text when nobody matches", async () => {
    await render();
    await open();
    await type("zzz");
    expect(itemEls()).toHaveLength(0);
    expect(document.body.textContent).toContain(messages.personPicker.empty);
  });

  it("offers the none item first and reports null", async () => {
    const onChange = vi.fn();
    await render({ noneLabel: "Unassigned", value: "u1", onChange });
    await open();
    expect(itemEls()[0]?.textContent).toContain("Unassigned");
    await act(async () => itemEls()[0]?.click());
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("has no none item without noneLabel", async () => {
    await render();
    await open();
    expect(itemEls()[0]?.textContent).toContain("Rina");
  });

  it("labels a deactivated person", async () => {
    await render();
    await open();
    const dede = itemEls().find((el) => el.textContent?.includes("Dede"));
    expect(dede?.textContent).toContain("(Deactivated)");
  });

  it("shows a dash for a value outside the list", async () => {
    const onChange = vi.fn();
    await render({ noneLabel: "Unassigned", value: "gone", onChange });
    expect(trigger()?.textContent?.trim()).toBe("—");
    await open();
    const rina = itemEls().find((el) => el.textContent?.includes("Rina"));
    await act(async () => rina?.click());
    await settle();
    expect(onChange).toHaveBeenLastCalledWith("u1");
  });

  it("action mode keeps its label and reports every pick, repeats included", async () => {
    const onChange = vi.fn();
    await render({
      value: undefined,
      actionLabel: "Set assignee",
      noneLabel: "Unassigned",
      onChange,
    });
    expect(trigger()?.textContent?.trim()).toBe("Set assignee");
    for (const name of ["Rina", "Rina", "Unassigned"]) {
      await open();
      const item = itemEls().find((el) => el.textContent?.includes(name));
      await act(async () => item?.click());
      await settle();
      expect(trigger()?.textContent?.trim()).toBe("Set assignee");
    }
    expect(onChange.mock.calls).toEqual([["u1"], ["u1"], [null]]);
  });

  it("compact variant uses the compact trigger", async () => {
    await render({ variant: "compact" });
    expect(trigger()?.className).toContain("border-transparent bg-transparent");
  });
});
