import { describe, expect, it } from "vitest";
import type { ProjectWithServers, Server } from "@/lib/db/schema";
import { sanitizeProject } from "@/lib/projects";

function makeServer(name: string): Server {
  return {
    id: `00000000-0000-0000-0000-0000000000${name}`,
    name: `server-${name}`,
    host: `${name}.example.com`,
    username: "ops",
    password: "super-secret-ssh-password",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function makeProject(
  overrides: Partial<ProjectWithServers> = {}
): ProjectWithServers {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Demo",
    dbServerId: "db",
    dbServiceType: "docker",
    dbServiceName: "pg",
    dbType: "postgres",
    dbName: "appdb",
    dbPassword: "db-secret",
    dbBackupPath: "/backups",
    backendServerId: "be",
    backendServiceType: "systemd",
    backendServiceName: "api",
    backendMockTimeApiUrl: "https://api.example.com/clock",
    backendMockTimeApiKey: "mock-time-api-key",
    frontendServerId: "fe",
    frontendServiceType: "docker",
    frontendServiceName: "web",
    dbServer: makeServer("11"),
    backendServer: makeServer("22"),
    frontendServer: makeServer("33"),
    ...overrides,
  };
}

describe("sanitizeProject", () => {
  it("strips the password from every server", () => {
    const safe = sanitizeProject(makeProject());
    for (const server of [
      safe.dbServer,
      safe.backendServer,
      safe.frontendServer,
    ]) {
      expect(server).not.toHaveProperty("password");
    }
  });

  it("strips dbPassword and backendMockTimeApiKey from the project", () => {
    const safe = sanitizeProject(makeProject());
    expect(safe).not.toHaveProperty("dbPassword");
    expect(safe).not.toHaveProperty("backendMockTimeApiKey");
  });

  it("sets presence flags true when secrets are present", () => {
    const safe = sanitizeProject(makeProject());
    expect(safe.hasDbPassword).toBe(true);
    expect(safe.hasMockTimeApiKey).toBe(true);
  });

  it("sets presence flags false when secrets are absent", () => {
    const safe = sanitizeProject(
      makeProject({ dbPassword: null, backendMockTimeApiKey: null })
    );
    expect(safe.hasDbPassword).toBe(false);
    expect(safe.hasMockTimeApiKey).toBe(false);
  });

  it("preserves non-secret fields", () => {
    const safe = sanitizeProject(makeProject());
    expect(safe.name).toBe("Demo");
    expect(safe.dbName).toBe("appdb");
    expect(safe.dbServer.name).toBe("server-11");
    expect(safe.dbServer.host).toBe("11.example.com");
  });
});
