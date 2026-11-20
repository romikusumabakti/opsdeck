import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  logos: [] as Record<string, unknown>[],
  selects: 0,
  fail: false,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => {
        const logos = async () => state.logos;
        return Object.assign(logos(), {
          where: () => ({
            limit: async () => {
              state.selects += 1;
              if (state.fail) throw new Error("db down");
              return [state.row];
            },
          }),
        });
      },
    }),
  },
}));

import {
  bootBrandName,
  DEFAULT_APP_NAME,
  getBranding,
  invalidateBranding,
} from "@/lib/instance-branding";

const empty = {
  name: null,
  company: null,
  accent: null,
  updatedAt: null,
};

describe("instance branding cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.row = { ...empty };
    state.selects = 0;
    state.fail = false;
    invalidateBranding();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.APP_NAME;
  });

  it("defaults to Menara, no company, neutral and no logo for an empty row", async () => {
    const b = await getBranding();
    expect(b.name).toBe(DEFAULT_APP_NAME);
    expect(b.name).toBe("Menara");
    expect(b.company).toBeNull();
    expect(b.accent).toBe("neutral");
    expect(b.logo).toBeNull();
    expect(b.logoDark).toBeNull();
    expect(b.version).toBe("0");
  });

  it("reads a stored name, company and accent; an unknown accent falls back to neutral", async () => {
    state.row = {
      name: "Acme Ops",
      company: "PT Acme",
      accent: "blue",
      updatedAt: new Date(1_700_000_000_000),
    };
    const b = await getBranding();
    expect(b).toMatchObject({
      name: "Acme Ops",
      company: "PT Acme",
      accent: "blue",
      version: (1_700_000_000_000).toString(36),
    });
    invalidateBranding();
    state.row = { ...state.row, accent: "teal" };
    expect((await getBranding()).accent).toBe("neutral");
  });

  it("serves from cache within the TTL and re-reads after 30 s", async () => {
    state.row = { ...empty, name: "Acme Ops" };
    await getBranding();
    await getBranding();
    expect(state.selects).toBe(1);
    // Another process wrote the row.
    state.row = { ...empty, name: "BETA Ops" };
    vi.advanceTimersByTime(30_001);
    const b = await getBranding();
    expect(state.selects).toBe(2);
    expect(b.name).toBe("BETA Ops");
  });

  it("shares one in-flight load between concurrent callers", async () => {
    await Promise.all([getBranding(), getBranding(), getBranding()]);
    expect(state.selects).toBe(1);
  });

  it("invalidateBranding makes the next read hit the database", async () => {
    await getBranding();
    invalidateBranding();
    await getBranding();
    expect(state.selects).toBe(2);
  });

  it("keeps the last good value when a reload fails", async () => {
    state.row = { ...empty, name: "Acme Ops" };
    await getBranding();
    state.fail = true;
    vi.advanceTimersByTime(30_001);
    expect((await getBranding()).name).toBe("Acme Ops");
  });

  it("returns env defaults when the first load fails", async () => {
    process.env.APP_NAME = "Env Ops";
    state.fail = true;
    expect((await getBranding()).name).toBe("Env Ops");
  });

  it("bootBrandName falls back to APP_NAME before priming", () => {
    process.env.APP_NAME = "Env Ops";
    expect(bootBrandName()).toBe("Env Ops");
    delete process.env.APP_NAME;
    expect(bootBrandName()).toBe(DEFAULT_APP_NAME);
  });
});
