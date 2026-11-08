import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const ZONE_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

type Existing = {
  kind: "tunnel" | "external";
  hostname: string;
  accessAppId: string | null;
  dnsRecordId: string | null;
};

const state = vi.hoisted(() => ({
  projectRole: "engineer" as string | null,
  orgRole: "member" as string,
  serverIds: ["srv-1"] as string[],
  tunnel: { id: "rt-1", name: "dss-113" } as {
    id: string;
    name: string;
  } | null,
  zone: { id: "zone-row", name: "dssconsulting.id" } as {
    id: string;
    name: string;
  } | null,
  takenHostnames: [] as string[],
  existing: undefined as Existing | undefined,
  policies: [
    { id: "pol-1", name: "Staff", decision: "allow", everyone: false },
    { id: "pol-bypass", name: "Bypass", decision: "bypass", everyone: false },
    { id: "pol-all", name: "Everyone", decision: "allow", everyone: true },
  ] as {
    id: string;
    name: string;
    decision: string;
    everyone: boolean;
  }[],
  stepsStarted: false,
  saveResult: true,
  deleteResult: true,
  zoneNames: ["dssconsulting.id"] as string[],
  saveError: null as unknown,
  accountMissing: false,
  saved: null as {
    write: Record<string, unknown>;
    entryPort?: number;
  } | null,
  deleted: false,
  // entry_port of the other environments on the deploy server.
  otherPorts: [] as number[],
  portQuery: null as null | { serverId: string; exclude?: string },
}));

vi.mock("@/server/services/preflight-repository", () => ({
  listEntryPortsOnServer: vi.fn(async (serverId: string, exclude?: string) => {
    state.portQuery = { serverId, exclude };
    return state.otherPorts;
  }),
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
  })),
}));

vi.mock("@/lib/authz", async () => {
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!state.projectRole) {
          throw new HTTPException(404, { message: "Not Found" });
        }
        if (!canProject(state.projectRole as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: { user: { id: "user-1", role: state.orgRole } },
          role: state.projectRole,
          projectId: "project-1",
        };
      }
    ),
  };
});

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

vi.mock("@/server/services/cloudflare-account", async (importOriginal) => {
  const { HTTPException } = await import("hono/http-exception");
  return {
    ...(await importOriginal<
      typeof import("@/server/services/cloudflare-account")
    >()),
    callCloudflare: vi.fn(async () => {
      if (state.accountMissing) {
        throw new HTTPException(409, {
          message: "The Cloudflare account is not set up",
        });
      }
      return state.policies;
    }),
  };
});

vi.mock("@/lib/domains/repository", () => ({
  getEnvironmentRow: vi.fn(async (id: string) =>
    id === ENV_ID ? { id, name: "HRIS Staging", entryPort: 8080 } : undefined
  ),
  listDeployServerIds: vi.fn(async () => state.serverIds),
  getRemoteTunnelByServer: vi.fn(async () => state.tunnel ?? undefined),
  getZone: vi.fn(async () => state.zone ?? undefined),
  listZones: vi.fn(async () =>
    state.zoneNames.map((name) => ({ id: name, name }))
  ),
  hasProvisioningProgress: vi.fn(async () => state.stepsStarted),
  hostnameTakenByOther: vi.fn(async (hostname: string) =>
    state.takenHostnames.includes(hostname)
  ),
  getDomain: vi.fn(async () => state.existing),
  getDomainView: vi.fn(async () =>
    state.existing
      ? {
          domain: {
            ...state.existing,
            zoneId: ZONE_ID,
            accessPolicyId: "pol-1",
          },
          zoneName: "dssconsulting.id",
          tunnelName: "dss-113",
        }
      : undefined
  ),
  saveDomain: vi.fn(
    async (_id: string, write: Record<string, unknown>, entryPort?: number) => {
      if (state.saveError) throw state.saveError;
      if (!state.saveResult) return false;
      state.saved = { write, entryPort };
      return true;
    }
  ),
  deleteDomain: vi.fn(async () => {
    if (!state.deleteResult) return false;
    state.deleted = true;
    return true;
  }),
}));

const { app } = await import("@/server/app");

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const url = `/api/environments/${ENV_ID}/domain`;
const tunnelBody = (extra: Record<string, unknown> = {}) => ({
  kind: "tunnel",
  zoneId: ZONE_ID,
  label: "hris-staging",
  accessPolicyId: "pol-1",
  entryPort: 8120,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.projectRole = "engineer";
  state.orgRole = "member";
  state.serverIds = ["srv-1"];
  state.tunnel = { id: "rt-1", name: "dss-113" };
  state.zone = { id: "zone-row", name: "dssconsulting.id" };
  state.takenHostnames = [];
  state.existing = undefined;
  state.stepsStarted = false;
  state.saveResult = true;
  state.deleteResult = true;
  state.saveError = null;
  state.zoneNames = ["dssconsulting.id"];
  state.accountMissing = false;
  state.saved = null;
  state.deleted = false;
  state.otherPorts = [];
  state.portQuery = null;
});

describe("PUT tunnel binding", () => {
  it("lets a maintainer bind with an Access policy", async () => {
    const res = await send("PUT", url, tunnelBody({ entryPort: 8999 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hostname: "hris-staging.dssconsulting.id",
    });
    expect(state.saved).toEqual({
      write: {
        kind: "tunnel",
        hostname: "hris-staging.dssconsulting.id",
        zoneId: "zone-row",
        remoteTunnelId: "rt-1",
        accessPolicyId: "pol-1",
      },
      entryPort: 8999,
    });
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "environment.domain.update" })
    );
  });

  it("refuses a public binding from a maintainer with 403, accepts it from an admin", async () => {
    const body = tunnelBody({ accessPolicyId: null });
    expect((await send("PUT", url, body)).status).toBe(403);
    expect(state.saved).toBeNull();

    state.orgRole = "admin";
    expect((await send("PUT", url, body)).status).toBe(200);
    expect(state.saved?.write).toMatchObject({ accessPolicyId: null });
  });

  it("refuses a viewer with 403 and a stranger with 404", async () => {
    state.projectRole = "viewer";
    expect((await send("PUT", url, tunnelBody())).status).toBe(403);
    state.projectRole = null;
    expect((await send("PUT", url, tunnelBody())).status).toBe(404);
  });

  it("answers 422 when the deploy server has no remote tunnel", async () => {
    state.tunnel = null;
    const res = await send("PUT", url, tunnelBody());
    expect(res.status).toBe(422);
    expect(state.saved).toBeNull();
  });

  it("answers 422 with no deploy targets or targets on two servers", async () => {
    state.serverIds = [];
    expect((await send("PUT", url, tunnelBody())).status).toBe(422);
    state.serverIds = ["srv-1", "srv-2"];
    const res = await send("PUT", url, tunnelBody());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/more than one server/);
  });

  it("answers 409 for a hostname another environment uses", async () => {
    state.takenHostnames = ["hris-staging.dssconsulting.id"];
    expect((await send("PUT", url, tunnelBody())).status).toBe(409);
    expect(state.saved).toBeNull();
  });

  it("answers 422 for a policy the account does not list", async () => {
    const res = await send("PUT", url, tunnelBody({ accessPolicyId: "gone" }));
    expect(res.status).toBe(422);
    expect(state.saved).toBeNull();
  });

  it("answers 409 when no Cloudflare account is set up", async () => {
    state.accountMissing = true;
    expect((await send("PUT", url, tunnelBody())).status).toBe(409);
  });

  it("does not look up policies for a public binding", async () => {
    state.orgRole = "admin";
    state.accountMissing = true;
    const res = await send("PUT", url, tunnelBody({ accessPolicyId: null }));
    expect(res.status).toBe(200);
  });

  it("answers 409 when the binding is already provisioned", async () => {
    state.existing = {
      kind: "tunnel",
      hostname: "hris-staging.dssconsulting.id",
      accessAppId: "app-1",
      dnsRecordId: null,
    };
    expect((await send("PUT", url, tunnelBody())).status).toBe(409);
    state.existing = { ...state.existing, accessAppId: null, dnsRecordId: "d" };
    expect((await send("PUT", url, tunnelBody())).status).toBe(409);
    expect(state.saved).toBeNull();
  });

  it("changes an unprovisioned binding", async () => {
    state.existing = {
      kind: "tunnel",
      hostname: "old.dssconsulting.id",
      accessAppId: null,
      dnsRecordId: null,
    };
    expect((await send("PUT", url, tunnelBody())).status).toBe(200);
  });

  it("answers 400 for an invalid label or port", async () => {
    expect((await send("PUT", url, tunnelBody({ label: "A.b" }))).status).toBe(
      400
    );
    expect(
      (await send("PUT", url, tunnelBody({ entryPort: 70_000 }))).status
    ).toBe(400);
  });
});

describe("entry port", () => {
  it("refuses a maintainer picking a port outside 8100–8999 with 403", async () => {
    for (const entryPort of [80, 8000, 8091, 8099, 9000]) {
      const res = await send("PUT", url, tunnelBody({ entryPort }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(
        "Only an admin can pick an entry port outside 8100–8999"
      );
    }
    expect(state.saved).toBeNull();
  });

  it("lets a maintainer pick a port in the range", async () => {
    const res = await send("PUT", url, tunnelBody({ entryPort: 8100 }));
    expect(res.status).toBe(200);
    expect(state.saved?.entryPort).toBe(8100);
    // The environment's own port does not count as taken.
    expect(state.portQuery).toEqual({ serverId: "srv-1", exclude: ENV_ID });
  });

  it("lets an admin pick any free port", async () => {
    state.orgRole = "admin";
    const res = await send("PUT", url, tunnelBody({ entryPort: 8091 }));
    expect(res.status).toBe(200);
    expect(state.saved?.entryPort).toBe(8091);
  });

  it("answers 409 for another environment's port on the server, for anyone", async () => {
    state.otherPorts = [8100, 8091];
    const maintainer = await send("PUT", url, tunnelBody({ entryPort: 8100 }));
    expect(maintainer.status).toBe(409);
    expect((await maintainer.json()).error).toBe(
      "Another environment on this server uses this entry port"
    );
    state.orgRole = "admin";
    const admin = await send("PUT", url, tunnelBody({ entryPort: 8091 }));
    expect(admin.status).toBe(409);
    expect(state.saved).toBeNull();
  });
});

describe("public-in-effect policies", () => {
  it("refuses a maintainer picking a bypass or an Everyone policy with 403", async () => {
    for (const accessPolicyId of ["pol-bypass", "pol-all"]) {
      const res = await send("PUT", url, tunnelBody({ accessPolicyId }));
      expect(res.status).toBe(403);
    }
    expect(state.saved).toBeNull();
  });

  it("lets an admin pick either", async () => {
    state.orgRole = "admin";
    for (const accessPolicyId of ["pol-bypass", "pol-all"]) {
      const res = await send("PUT", url, tunnelBody({ accessPolicyId }));
      expect(res.status).toBe(200);
    }
  });

  it("filters them out of the list for a maintainer, not for an admin", async () => {
    const list = await (await send("GET", `${url}/access-policies`)).json();
    expect(list).toEqual([{ id: "pol-1", name: "Staff" }]);
    state.orgRole = "admin";
    const all = await (await send("GET", `${url}/access-policies`)).json();
    expect(all.map((p: { id: string }) => p.id)).toEqual([
      "pol-1",
      "pol-bypass",
      "pol-all",
    ]);
  });
});

describe("provisioning guard", () => {
  it("a done or running Cloudflare step blocks PUT and DELETE with 409", async () => {
    state.stepsStarted = true;
    state.existing = {
      kind: "tunnel",
      hostname: "hris-staging.dssconsulting.id",
      accessAppId: null,
      dnsRecordId: null,
    };
    expect((await send("PUT", url, tunnelBody())).status).toBe(409);
    expect((await send("DELETE", url)).status).toBe(409);
    expect(state.saved).toBeNull();
    expect(state.deleted).toBe(false);
  });

  it("answers 409 when the guarded write returns no row", async () => {
    state.saveResult = false;
    const put = await send("PUT", url, tunnelBody());
    expect(put.status).toBe(409);
    expect((await put.json()).error).toMatch(/already provisioned/);

    state.existing = {
      kind: "external",
      hostname: "app.example.com",
      accessAppId: null,
      dnsRecordId: null,
    };
    state.deleteResult = false;
    expect((await send("DELETE", url)).status).toBe(409);
  });
});

describe("PUT external binding", () => {
  it("refuses a hostname under a registered zone with 422", async () => {
    for (const hostname of ["dssconsulting.id", "x.y.dssconsulting.id"]) {
      const res = await send("PUT", url, { kind: "external", hostname });
      expect(res.status).toBe(422);
    }
    const ok = await send("PUT", url, {
      kind: "external",
      hostname: "notdssconsulting.id",
    });
    expect(ok.status).toBe(200);
  });

  it("maps a unique violation to 409", async () => {
    state.saveError = Object.assign(new Error("dup"), { code: "23505" });
    const res = await send("PUT", url, {
      kind: "external",
      hostname: "app.example.com",
    });
    expect(res.status).toBe(409);
  });

  it("records a lowercased FQDN without touching Cloudflare", async () => {
    state.accountMissing = true;
    state.tunnel = null;
    const res = await send("PUT", url, {
      kind: "external",
      hostname: "App.Example.com",
    });
    expect(res.status).toBe(200);
    expect(state.saved).toEqual({
      write: {
        kind: "external",
        hostname: "app.example.com",
        zoneId: null,
        remoteTunnelId: null,
        accessPolicyId: null,
      },
      entryPort: undefined,
    });
  });

  it("answers 409 for a taken hostname and 400 for a non-FQDN", async () => {
    state.takenHostnames = ["app.example.com"];
    expect(
      (
        await send("PUT", url, {
          kind: "external",
          hostname: "app.example.com",
        })
      ).status
    ).toBe(409);
    expect(
      (await send("PUT", url, { kind: "external", hostname: "localhost" }))
        .status
    ).toBe(400);
  });
});

describe("GET and DELETE", () => {
  it("lets a viewer read the binding", async () => {
    state.projectRole = "viewer";
    state.existing = {
      kind: "tunnel",
      hostname: "hris-staging.dssconsulting.id",
      accessAppId: null,
      dnsRecordId: null,
    };
    const res = await send("GET", url);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      entryPort: 8080,
      domain: { label: "hris-staging", tunnelName: "dss-113" },
    });
  });

  it("lists policies for a maintainer only", async () => {
    const ok = await send("GET", `${url}/access-policies`);
    expect(await ok.json()).toEqual([{ id: "pol-1", name: "Staff" }]);
    state.projectRole = "viewer";
    expect((await send("GET", `${url}/access-policies`)).status).toBe(403);
  });

  it("removes an unprovisioned binding and refuses a provisioned one", async () => {
    state.existing = {
      kind: "external",
      hostname: "app.example.com",
      accessAppId: null,
      dnsRecordId: null,
    };
    expect((await send("DELETE", url)).status).toBe(200);
    expect(state.deleted).toBe(true);

    state.deleted = false;
    state.existing = { ...state.existing, dnsRecordId: "d" };
    expect((await send("DELETE", url)).status).toBe(409);
    expect(state.deleted).toBe(false);
  });
});
