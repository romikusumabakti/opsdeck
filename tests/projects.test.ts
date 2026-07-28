import { describe, expect, it } from "vitest";
import type {
  EnvironmentWithServers,
  Server,
  ServiceWithServer,
} from "@/lib/db/schema";
import { sanitizeProject } from "@/lib/projects";
import { backendService, dbService } from "@/lib/services";

function makeServer(name: string): Server {
  return {
    id: `00000000-0000-0000-0000-0000000000${name}`,
    name: `server-${name}`,
    host: `${name}.example.com`,
    username: "ops",
    password: "super-secret-ssh-password",
    sftpRoot: "/",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function makeDbService(
  overrides: Partial<ServiceWithServer> = {}
): ServiceWithServer {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    environmentId: "11111111-1111-1111-1111-111111111111",
    role: "db",
    serverId: "db",
    serviceType: "docker",
    serviceName: "pg",
    dbType: "postgres",
    dbName: "appdb",
    dbPassword: "db-secret",
    dbBackupPath: "/backups",
    mockTimeApiUrl: null,
    mockTimeApiKey: null,
    server: makeServer("11"),
    ...overrides,
  };
}

function makeBackendService(
  overrides: Partial<ServiceWithServer> = {}
): ServiceWithServer {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    environmentId: "11111111-1111-1111-1111-111111111111",
    role: "backend",
    serverId: "be",
    serviceType: "systemd",
    serviceName: "api",
    dbType: null,
    dbName: null,
    dbPassword: null,
    dbBackupPath: null,
    mockTimeApiUrl: "https://api.example.com/clock",
    mockTimeApiKey: "mock-time-api-key",
    server: makeServer("22"),
    ...overrides,
  };
}

function makeFrontendService(
  overrides: Partial<ServiceWithServer> = {}
): ServiceWithServer {
  return {
    id: "55555555-5555-5555-5555-555555555555",
    environmentId: "11111111-1111-1111-1111-111111111111",
    role: "frontend",
    serverId: "fe",
    serviceType: "docker",
    serviceName: "web",
    dbType: null,
    dbName: null,
    dbPassword: null,
    dbBackupPath: null,
    mockTimeApiUrl: null,
    mockTimeApiKey: null,
    server: makeServer("33"),
    ...overrides,
  };
}

function makeProject(
  overrides: Partial<EnvironmentWithServers> = {}
): EnvironmentWithServers {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "22222222-2222-2222-2222-222222222222",
    name: "Demo",
    slug: "demo",
    kind: null,
    owner: null,
    services: [makeDbService(), makeBackendService(), makeFrontendService()],
    ...overrides,
  };
}

describe("sanitizeProject", () => {
  it("strips the password from every server", () => {
    const safe = sanitizeProject(makeProject());
    for (const service of safe.services) {
      expect(service.server).not.toHaveProperty("password");
    }
  });

  it("strips dbPassword and mockTimeApiKey from every service", () => {
    const safe = sanitizeProject(makeProject());
    for (const service of safe.services) {
      expect(service).not.toHaveProperty("dbPassword");
      expect(service).not.toHaveProperty("mockTimeApiKey");
    }
  });

  it("sets presence flags true when secrets are present", () => {
    const safe = sanitizeProject(makeProject());
    expect(dbService(safe).hasDbPassword).toBe(true);
    expect(backendService(safe).hasMockTimeApiKey).toBe(true);
  });

  it("sets presence flags false when secrets are absent", () => {
    const safe = sanitizeProject(
      makeProject({
        services: [
          makeDbService({ dbPassword: null }),
          makeBackendService({ mockTimeApiKey: null }),
          makeFrontendService(),
        ],
      })
    );
    expect(dbService(safe).hasDbPassword).toBe(false);
    expect(backendService(safe).hasMockTimeApiKey).toBe(false);
  });

  it("preserves non-secret fields", () => {
    const safe = sanitizeProject(makeProject());
    expect(safe.name).toBe("Demo");
    expect(dbService(safe).dbName).toBe("appdb");
    expect(dbService(safe).server.name).toBe("server-11");
    expect(dbService(safe).server.host).toBe("11.example.com");
  });
});
