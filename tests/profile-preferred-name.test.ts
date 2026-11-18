import { beforeEach, describe, expect, it, vi } from "vitest";
import { callName } from "@/lib/user-display";
import { PROFILE_LIMITS, profileInputSchema } from "@/lib/validation";

// The preferred name: what the greeting and the assistant call a user,
// falling back to the full display name (never a guessed first word).

describe("callName", () => {
  it.each([
    [{ name: "Romi Kusuma Bakti", preferredName: "Romi" }, "Romi"],
    [{ name: "Romi Kusuma Bakti", preferredName: "  Romi  " }, "Romi"],
    [{ name: "Romi Kusuma Bakti", preferredName: "   " }, "Romi Kusuma Bakti"],
    [{ name: "Romi Kusuma Bakti", preferredName: null }, "Romi Kusuma Bakti"],
    // Some given names are several words: kept whole.
    [{ name: "Ana Maria Lopez", preferredName: "Ana Maria" }, "Ana Maria"],
    [{ name: "Ana Maria Lopez", preferredName: null }, "Ana Maria Lopez"],
  ])("%o → %s", (user, expected) => {
    expect(callName(user)).toBe(expected);
  });
});

const base = {
  name: "Engineer",
  title: null,
  bio: null,
  timezone: null,
  workingHours: null,
};

describe("profileInputSchema preferredName", () => {
  it("trims, turns blank into null and caps at 40 characters", () => {
    expect(PROFILE_LIMITS.preferredName).toBe(40);
    const parse = (preferredName: string | null) =>
      profileInputSchema.safeParse({ ...base, preferredName });
    expect(parse("  Romi ").data?.preferredName).toBe("Romi");
    expect(parse("   ").data?.preferredName).toBeNull();
    expect(parse(null).data?.preferredName).toBeNull();
    expect(parse("x".repeat(40)).success).toBe(true);
    expect(parse("x".repeat(41)).success).toBe(false);
  });
});

const state = vi.hoisted(() => ({
  sets: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth-session", () => {
  const session = { user: { id: "user-1", role: "qa" }, session: {} };
  return {
    requireSession: vi.fn(async () => session),
    getServerSession: vi.fn(async () => session),
  };
});
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.sets.push(values);
        return { where: async () => [] };
      },
    }),
  },
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");

const post = (preferredName: unknown) =>
  app.request("/api/profile/update-profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { ...base, preferredName } }),
  });

beforeEach(() => {
  state.sets = [];
});

describe("POST /api/profile/update-profile", () => {
  it("saves a trimmed preferred name", async () => {
    const res = await post("  Romi ");
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(state.sets).toEqual([
      expect.objectContaining({ name: "Engineer", preferredName: "Romi" }),
    ]);
  });

  it("clears it when blank", async () => {
    expect((await post("  ")).status).toBe(200);
    expect(state.sets[0]?.preferredName).toBeNull();
  });

  it("answers 400 for 41 characters and writes nothing", async () => {
    expect((await post("x".repeat(41))).status).toBe(400);
    expect(state.sets).toEqual([]);
  });
});
