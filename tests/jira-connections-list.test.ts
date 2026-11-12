import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const row = vi.hoisted(() => ({
  id: "j1",
  name: "Acme",
  baseUrl: "https://acme.atlassian.net",
  flavor: "cloud",
  email: "bot@acme.test",
  apiToken: "x",
  webhookSecret: "s3cret",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
}));

vi.mock("@/lib/authz", () => ({
  requireOrgPermission: vi.fn(async () => undefined),
  requireProjectPermission: vi.fn(async () => undefined),
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ orderBy: async () => [row] }),
    }),
  },
}));

const { getJiraConnections } = await import("@/server/services/jira");

describe("getJiraConnections", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://panel.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists each connection with its webhook URL and no secrets", async () => {
    const [first] = await getJiraConnections();
    expect(first?.webhookUrl).toBe(
      "https://panel.test/api/jira/webhook/s3cret"
    );
    expect(first && "webhookSecret" in first).toBe(false);
    expect(first && "apiToken" in first).toBe(false);
  });
});
