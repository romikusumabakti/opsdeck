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
  projectRole: "maintainer" as string | null,
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
  policies: [{ id: "pol-1", name: "Staff" }] as { id: string; name: string }[],
  accountMissing: false,
  saved: null as {
    write: Record<string, unknown>;
    entryPort?: number;
  } | null,
  deleted: false,
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
  listZones: vi.fn(async () => (state.zone ? [state.zone] : [])),
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
      state.saved = { write, entryPort };
    }
  ),
  deleteDomain: vi.fn(async () => {
    state.deleted = true;
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
  entryPort: 8080,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.projectRole = "maintainer";
  state.orgRole = "member";
  state.serverIds = ["srv-1"];
  state.tunnel = { id: "rt-1", name: "dss-113" };
  state.zone = { id: "zone-row", name: "dssconsulting.id" };
  state.takenHostnames = [];
  state.existing = undefined;
  state.policies = [{ id: "pol-1", name: "Staff" }];
  state.accountMissing = false;
  state.saved = null;
  state.deleted = false;
});

describe("PUT tunnel binding", () => {
  it("lets a maintainer bind with an Access policy", async () => {
    const res = await send("PUT", url, tunnelBody({ entryPort: 9000 }));
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
      entryPort: 9000,
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

describe("PUT external binding", () => {
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
