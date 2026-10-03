import { describe, expect, it } from "bun:test";
import type {
  EnvironmentWithServers,
  Server,
  ServiceWithServer,
} from "@/lib/db/schema";
import {
  changedInfraFields,
  type INFRA_FIELDS,
  sanitizeEnvironment,
} from "@/lib/environments";
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
    dbUser: null,
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
    dbUser: null,
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
    dbUser: null,
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

describe("sanitizeEnvironment", () => {
  it("strips the password from every server", () => {
    const safe = sanitizeEnvironment(makeProject());
    for (const service of safe.services) {
      expect(service.server).not.toHaveProperty("password");
    }
  });

  it("strips dbPassword and mockTimeApiKey from every service", () => {
    const safe = sanitizeEnvironment(makeProject());
    for (const service of safe.services) {
      expect(service).not.toHaveProperty("dbPassword");
      expect(service).not.toHaveProperty("mockTimeApiKey");
    }
  });

  it("sets presence flags true when secrets are present", () => {
    const safe = sanitizeEnvironment(makeProject());
    expect(dbService(safe).hasDbPassword).toBe(true);
    expect(backendService(safe).hasMockTimeApiKey).toBe(true);
  });

  it("sets presence flags false when secrets are absent", () => {
    const safe = sanitizeEnvironment(
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
    const safe = sanitizeEnvironment(makeProject());
    expect(safe.name).toBe("Demo");
    expect(dbService(safe).dbName).toBe("appdb");
    expect(dbService(safe).server.name).toBe("server-11");
    expect(dbService(safe).server.host).toBe("11.example.com");
  });
});

describe("changedInfraFields", () => {
  // The full payload the settings form re-submits with nothing edited.
  const unchanged = {
    projectId: "22222222-2222-2222-2222-222222222222",
    name: "Demo renamed",
    kind: "qa" as const,
    owner: "QA team",
    dbServerId: "db",
    dbServiceType: "docker" as const,
    dbServiceName: "pg",
    dbType: "postgres" as const,
    dbName: "appdb",
    dbUser: null,
    dbBackupPath: "/backups",
    backendServerId: "be",
    backendServiceType: "systemd" as const,
    backendServiceName: "api",
    backendMockTimeApiUrl: "https://api.example.com/clock",
    frontendServerId: "fe",
    frontendServiceType: "docker" as const,
    frontendServiceName: "web",
  };

  it("reports nothing when only name/kind/owner/project change", () => {
    expect(changedInfraFields(unchanged, makeProject())).toEqual([]);
  });

  it("reports nothing for an empty payload", () => {
    expect(changedInfraFields({}, makeProject())).toEqual([]);
  });

  // Comparing a submitted secret with the stored one would let a caller without
  // server:manage confirm a guess (allowed when equal, forbidden otherwise).
  it("always flags a submitted secret, even one equal to the stored value", () => {
    expect(
      changedInfraFields(
        { dbPassword: "db-secret", backendMockTimeApiKey: "mock-time-api-key" },
        makeProject()
      )
    ).toEqual(["dbPassword", "backendMockTimeApiKey"]);
  });

  it("flags a submitted null secret too", () => {
    expect(
      changedInfraFields(
        { dbPassword: null, backendMockTimeApiKey: null },
        makeProject()
      )
    ).toEqual(["dbPassword", "backendMockTimeApiKey"]);
  });

  it("flags a server rebinding", () => {
    expect(
      changedInfraFields({ ...unchanged, dbServerId: "other" }, makeProject())
    ).toEqual(["dbServerId"]);
  });

  it("flags every infra field individually", () => {
    const changes: Record<keyof typeof INFRA_FIELDS, unknown> = {
      dbServerId: "x",
      dbServiceType: "systemd",
      dbServiceName: "x",
      dbType: "mysql",
      dbName: "x",
      dbUser: "root",
      dbPassword: "new-secret",
      dbBackupPath: "/x",
      backendServerId: "x",
      backendServiceType: "docker",
      backendServiceName: "x",
      backendMockTimeApiUrl: "http://169.254.169.254/",
      backendMockTimeApiKey: "new-key",
      frontendServerId: "x",
      frontendServiceType: "kubernetes",
      frontendServiceName: "x",
    };
    for (const [field, value] of Object.entries(changes)) {
      expect(changedInfraFields({ [field]: value }, makeProject())).toEqual([
        field as keyof typeof INFRA_FIELDS,
      ]);
    }
  });

  it("flags clearing a stored value", () => {
    expect(
      changedInfraFields({ backendMockTimeApiUrl: null }, makeProject())
    ).toEqual(["backendMockTimeApiUrl"]);
  });

  it("counts fields for a missing service row as changes", () => {
    expect(
      changedInfraFields(
        { frontendServiceName: "web" },
        makeProject({ services: [makeDbService(), makeBackendService()] })
      )
    ).toEqual(["frontendServiceName"]);
  });
});
