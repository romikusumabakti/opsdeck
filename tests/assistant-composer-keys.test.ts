import { describe, expect, it } from "vitest";
import {
  opensContextPicker,
  shouldSend,
} from "@/web/components/assistant/composer-keys";

const base = { key: "Enter", shiftKey: false, isComposing: false };

describe("shouldSend", () => {
  it("sends on a plain Enter", () => {
    expect(shouldSend(base)).toBe(true);
  });
  it("does not send on Shift+Enter", () => {
    expect(shouldSend({ ...base, shiftKey: true })).toBe(false);
  });
  it("does not send while an IME composition is active", () => {
    expect(shouldSend({ ...base, isComposing: true })).toBe(false);
    expect(shouldSend({ ...base, keyCode: 229 })).toBe(false);
  });
  it("ignores other keys", () => {
    expect(shouldSend({ ...base, key: "a" })).toBe(false);
  });
});

describe("opensContextPicker", () => {
  it("opens on @ typed into an empty box", () => {
    expect(opensContextPicker("", "@")).toBe(true);
  });
  it("leaves @ in text alone (@Transactional, @scope/pkg, e-mail)", () => {
    expect(opensContextPicker("use ", "use @")).toBe(false);
    expect(opensContextPicker("user", "user@")).toBe(false);
    expect(opensContextPicker("question", "@question")).toBe(false);
  });
  it("does not open on a paste or another character", () => {
    expect(opensContextPicker("", "@acme")).toBe(false);
    expect(opensContextPicker("", "a")).toBe(false);
  });
});
