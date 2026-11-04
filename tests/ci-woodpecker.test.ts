import { describe, expect, it, vi } from "vitest";
import { CiProviderError } from "@/lib/ci/types";
import { createWoodpeckerProvider } from "@/lib/ci/woodpecker";

const BASE = "https://ci.example.test";
const TOKEN = "super-secret-token";
const REMOTE = "{35a90db5-104e-494d-bd2a-2addeae8a8ff}";

type Call = { url: string; method: string; headers: Headers; body?: unknown };

function mockFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  });
  return {
    calls,
    provider: createWoodpeckerProvider(BASE, TOKEN, impl as never),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("woodpecker provider", () => {
  it("lists repos, mapping ids to strings and inactive repos to empty ids", async () => {
    const { calls, provider } = mockFetch([
      json([
        { id: 7, full_name: "o/a", forge_remote_id: REMOTE, active: true },
        { full_name: "o/b", forge_remote_id: "x", active: false },
      ]),
    ]);
    const repos = await provider.listRepos();
    expect(calls[0]?.url).toBe(`${BASE}/api/user/repos?all=true`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(repos).toEqual([
      { ciRepoId: "7", fullName: "o/a", forgeRemoteId: REMOTE, active: true },
      { ciRepoId: "", fullName: "o/b", forgeRemoteId: "x", active: false },
    ]);
  });

  it("URL-encodes the forge remote id when activating", async () => {
    const { calls, provider } = mockFetch([
      json({ id: 9, full_name: "o/a", forge_remote_id: REMOTE, active: true }),
    ]);
    const repo = await provider.activateRepo(REMOTE);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/repos?forge_remote_id=%7B35a90db5-104e-494d-bd2a-2addeae8a8ff%7D`
    );
    expect(repo.ciRepoId).toBe("9");
  });

  it("returns the existing repo when it is already active", async () => {
    const { calls, provider } = mockFetch([
      json({ id: 0, message: "repo already activated" }, 409),
      json([
        {
          id: 4,
          full_name: "dss-consulting/hris",
          forge_remote_id: REMOTE,
          active: true,
        },
      ]),
      json({
        id: 4,
        full_name: "dss-consulting/hris",
        forge_remote_id: REMOTE,
        active: true,
      }),
    ]);
    const repo = await provider.activateRepo(REMOTE);
    expect(repo).toEqual({
      ciRepoId: "4",
      fullName: "dss-consulting/hris",
      forgeRemoteId: REMOTE,
      active: true,
    });
    expect(calls[2]?.url).toBe(`${BASE}/api/repos/lookup/dss-consulting/hris`);
  });

  it("sends exactly the five settings fields", async () => {
    const { calls, provider } = mockFetch([
      new Response(null, { status: 200 }),
    ]);
    await provider.updateRepoSettings("12", {
      timeoutMinutes: 30,
      cancelPreviousOnPush: true,
      configExtensionEndpoint: "https://p.test/api/ci/config/c1",
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(`${BASE}/api/repos/12`);
    expect(calls[0]?.body).toEqual({
      timeout: 30,
      cancel_previous_pipeline_events: ["push"],
      config_extension_endpoint: "https://p.test/api/ci/config/c1",
      config_extension_exclusive: false,
      config_extension_netrc: false,
    });
  });

  it("sends an empty cancel list and null endpoint when disabled", async () => {
    const { calls, provider } = mockFetch([
      new Response(null, { status: 200 }),
    ]);
    await provider.updateRepoSettings("12", {
      timeoutMinutes: 60,
      cancelPreviousOnPush: false,
      configExtensionEndpoint: null,
    });
    expect(calls[0]?.body).toMatchObject({
      cancel_previous_pipeline_events: [],
      config_extension_endpoint: "",
    });
  });

  it("PATCHes a secret that exists", async () => {
    const { calls, provider } = mockFetch([
      json({ name: "opsdeck_notify" }),
      json({ name: "opsdeck_notify" }),
    ]);
    await provider.upsertRepoSecret("5", "opsdeck_notify", "v", [
      "push",
      "manual",
    ]);
    expect(calls[0]?.url).toBe(`${BASE}/api/repos/5/secrets/opsdeck_notify`);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.url).toBe(`${BASE}/api/repos/5/secrets/opsdeck_notify`);
    expect(calls[1]?.body).toEqual({ value: "v", events: ["push", "manual"] });
  });

  it("POSTs a secret that is missing", async () => {
    const { calls, provider } = mockFetch([
      new Response("not found", { status: 404 }),
      json({ name: "opsdeck_notify" }),
    ]);
    await provider.upsertRepoSecret("5", "opsdeck_notify", "v", ["push"]);
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe(`${BASE}/api/repos/5/secrets`);
    expect(calls[1]?.body).toEqual({
      name: "opsdeck_notify",
      value: "v",
      events: ["push"],
    });
  });

  it("returns the extension public key text", async () => {
    const { calls, provider } = mockFetch([
      new Response(
        "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n"
      ),
    ]);
    expect(await provider.fetchExtensionPublicKey()).toContain(
      "BEGIN PUBLIC KEY"
    );
    expect(calls[0]?.url).toBe(`${BASE}/api/signature/public-key`);
  });

  it("throws CiProviderError on 401 without leaking the token", async () => {
    const { provider } = mockFetch([
      new Response("unauthorized", { status: 401 }),
    ]);
    const err = await provider.listRepos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).status).toBe(401);
    expect((err as CiProviderError).message).not.toContain(TOKEN);
  });

  it("wraps transport failures without leaking the token", async () => {
    const impl = vi.fn(async () => {
      throw new Error(`connect failed with ${TOKEN}`);
    });
    const provider = createWoodpeckerProvider(BASE, TOKEN, impl as never);
    const err = await provider.listRepos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).message).not.toContain(TOKEN);
  });
});
