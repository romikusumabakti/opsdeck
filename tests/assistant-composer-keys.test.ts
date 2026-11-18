import { describe, expect, it } from "vitest";
import { shouldSend } from "@/web/components/assistant/composer-keys";

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
