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
    expect(opensContextPicker("", "@", 1)).toBe(true);
  });
  it("opens on @ typed after a space or a new line", () => {
    expect(opensContextPicker("Where is ", "Where is @", 10)).toBe(true);
    expect(opensContextPicker("Line\n", "Line\n@", 6)).toBe(true);
    expect(opensContextPicker("a  b", "a @ b", 3)).toBe(true);
  });
  it("does not open inside a word (an e-mail address)", () => {
    expect(opensContextPicker("user", "user@", 5)).toBe(false);
  });
  it("does not open on @ typed in front of existing text", () => {
    expect(opensContextPicker("question", "@question", 1)).toBe(false);
  });
  it("does not open on a paste or another character", () => {
    expect(opensContextPicker("", "@acme", 5)).toBe(false);
    expect(opensContextPicker("", "a", 1)).toBe(false);
  });
});
