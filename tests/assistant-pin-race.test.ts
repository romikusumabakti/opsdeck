import { describe, expect, it, vi } from "vitest";

// setConversationPinned checks the chat, then writes: a chat deleted (or
// pruned) between the two answers "not_found", never "ok".

const state = vi.hoisted(() => ({
  found: [{ temporary: false }] as { temporary: boolean }[],
  updated: [] as { id: string }[],
}));
vi.mock("@/lib/db", () => {
  const select = () => {
    // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: async () => state.found,
    };
    return chain;
  };
  const update = () => ({
    set: () => ({
      where: () => ({ returning: async () => state.updated }),
    }),
  });
  return { db: { select, update } };
});

const { setConversationPinned } = await import(
  "@/lib/assistant/conversation-store"
);

const USER = "00000000-0000-7000-8000-0000000000a1";
const CHAT = "00000000-0000-7000-8000-0000000000c1";

describe("setConversationPinned", () => {
  it("is not_found when the chat went between the check and the write", async () => {
    state.updated = [];
    expect(await setConversationPinned(USER, CHAT, true)).toBe("not_found");
  });

  it("is ok when the write matched the chat", async () => {
    state.updated = [{ id: CHAT }];
    expect(await setConversationPinned(USER, CHAT, true)).toBe("ok");
  });
});
