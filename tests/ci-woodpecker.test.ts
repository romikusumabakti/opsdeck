import { describe, expect, it, vi } from "vitest";
import { CiProviderError } from "@/lib/ci/types";
import {
  createWoodpeckerProvider,
  parsePipelineNumber,
  verifyWoodpeckerToken,
} from "@/lib/ci/woodpecker";

const BASE = "https://ci.example.test";
const TOKEN = "super-secret-token";
const REMOTE = "{35a90db5-104e-494d-bd2a-2addeae8a8ff}";

type Call = {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
  init: RequestInit;
};

function mockFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      init: init ?? {},
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
        {
          id: 7,
          full_name: "o/a",
          forge_remote_id: REMOTE,
          active: true,
          default_branch: "develop",
        },
        { full_name: "o/b", forge_remote_id: "x", active: false },
      ]),
    ]);
    const repos = await provider.listRepos();
    expect(calls[0]?.url).toBe(`${BASE}/api/user/repos?all=true`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(repos).toEqual([
      {
        ciRepoId: "7",
        fullName: "o/a",
        forgeRemoteId: REMOTE,
        active: true,
        defaultBranch: "develop",
      },
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

  it("falls back to the lookup only on 409", async () => {
    for (const status of [400, 404, 422, 500]) {
      const { calls, provider } = mockFetch([
        json({ message: "nope" }, status),
      ]);
      const err = await provider.activateRepo(REMOTE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CiProviderError);
      expect((err as CiProviderError).status).toBe(status);
      expect(calls).toHaveLength(1);
    }
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

  it("throws CiProviderError on 401 without leaking the token", async () => {
    const { provider } = mockFetch([
      new Response("unauthorized", { status: 401 }),
    ]);
    const err = await provider.listRepos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).status).toBe(401);
    expect((err as CiProviderError).message).not.toContain(TOKEN);
  });

  it("does not follow redirects and sets a 15 s timeout", async () => {
    const { calls, provider } = mockFetch([json([])]);
    await provider.listRepos();
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a redirect (e.g. to a Cloudflare Access login)", async () => {
    const { calls, provider } = mockFetch([
      new Response(null, {
        status: 302,
        headers: { Location: "https://dss.cloudflareaccess.com/login" },
      }),
    ]);
    const err = await provider.listRepos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).status).toBe(302);
    expect((err as CiProviderError).message).toBe(
      "Woodpecker GET /api/user/repos?all=true redirected — check the URL/Access"
    );
    expect(calls).toHaveLength(1);
  });

  it("reports a timeout with a fixed message and status 0", async () => {
    const impl = vi.fn(async () => {
      throw new DOMException(`timed out ${TOKEN}`, "TimeoutError");
    });
    const provider = createWoodpeckerProvider(BASE, TOKEN, impl as never);
    const err = await provider.listRepos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).status).toBe(0);
    expect((err as CiProviderError).message).toBe(
      "Woodpecker GET /api/user/repos?all=true timed out"
    );
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

describe("woodpecker getPipeline", () => {
  it("GETs the pipeline by repo id and number and maps the actor fields", async () => {
    const { calls, provider } = mockFetch([
      json({
        number: 7,
        sender: "romi",
        author: "romi",
        author_email: "romi@example.test",
        message: "fix: thing\n\nbody",
      }),
    ]);
    await expect(provider.getPipeline("2", 7)).resolves.toEqual({
      sender: "romi",
      authorEmail: "romi@example.test",
      message: "fix: thing\n\nbody",
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/api/repos/2/pipelines/7`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("maps missing and empty fields to null", async () => {
    const { provider } = mockFetch([json({ sender: "", message: null })]);
    await expect(provider.getPipeline("2", 7)).resolves.toEqual({
      sender: null,
      authorEmail: null,
      message: null,
    });
  });

  it("answers nulls for a pipeline that does not exist (404)", async () => {
    const { provider } = mockFetch([json({ message: "not found" }, 404)]);
    await expect(provider.getPipeline("2", 7)).resolves.toEqual({
      sender: null,
      authorEmail: null,
      message: null,
    });
  });

  it("throws CiProviderError on other failures", async () => {
    const { provider } = mockFetch([json({}, 500)]);
    const err = await provider.getPipeline("2", 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).status).toBe(500);
    expect((err as CiProviderError).message).not.toContain(TOKEN);
  });
});

describe("woodpecker triggerPipeline", () => {
  it("POSTs the branch to the repo's pipelines and returns the number", async () => {
    const { calls, provider } = mockFetch([json({ number: 12, id: 99 })]);
    await expect(
      provider.triggerPipeline("2", "sucor/development")
    ).resolves.toEqual({ number: 12 });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/repos/2/pipelines`);
    expect(calls[0]?.body).toEqual({
      branch: "sucor/development",
      variables: {},
    });
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("turns a 404 into a CiProviderError without the token", async () => {
    const { provider } = mockFetch([json({ message: "not found" }, 404)]);
    const err = await provider.triggerPipeline("2", "main").catch((e) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).status).toBe(404);
    expect((err as CiProviderError).message).not.toContain(TOKEN);
  });

  it("rejects an answer without a pipeline number", async () => {
    const { provider } = mockFetch([json({})]);
    await expect(provider.triggerPipeline("2", "main")).rejects.toBeInstanceOf(
      CiProviderError
    );
  });
});

describe("woodpecker listActivePipelines", () => {
  it("GETs a bounded page of the branch's pipelines and keeps the active ones, newest first", async () => {
    const { calls, provider } = mockFetch([
      json([
        { number: 9, branch: "sucor/development", status: "success" },
        { number: 11, branch: "sucor/development", status: "pending" },
        { number: 12, branch: "main", status: "running" },
        { number: 14, branch: "sucor/development", status: "running" },
        { number: 10, branch: "sucor/development", status: "failure" },
      ]),
    ]);
    await expect(
      provider.listActivePipelines("2", "sucor/development")
    ).resolves.toEqual([
      { number: 14, url: `${BASE}/repos/2/pipeline/14` },
      { number: 11, url: `${BASE}/repos/2/pipeline/11` },
    ]);
    expect(calls[0]?.method).toBe("GET");
    const url = new URL(calls[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      `${BASE}/api/repos/2/pipelines`
    );
    expect(url.searchParams.get("branch")).toBe("sucor/development");
    expect(url.searchParams.get("perPage")).toBe("20");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("answers an empty list when nothing is active or the answer is not a list", async () => {
    const { provider } = mockFetch([
      json([{ number: 3, branch: "main", status: "success" }]),
      json(null),
    ]);
    await expect(provider.listActivePipelines("2", "main")).resolves.toEqual(
      []
    );
    await expect(provider.listActivePipelines("2", "main")).resolves.toEqual(
      []
    );
  });

  it("skips entries without a valid number", async () => {
    const { provider } = mockFetch([
      json([
        { number: "7", branch: "main", status: "running" },
        { branch: "main", status: "running" },
      ]),
    ]);
    await expect(provider.listActivePipelines("2", "main")).resolves.toEqual(
      []
    );
  });

  it("throws CiProviderError without the token on failure", async () => {
    const { provider } = mockFetch([json({}, 500)]);
    const err = await provider
      .listActivePipelines("2", "main")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect((err as CiProviderError).status).toBe(500);
    expect((err as CiProviderError).message).not.toContain(TOKEN);
  });
});

describe("parsePipelineNumber", () => {
  it("reads the number from a pipeline URL of the component's repo", () => {
    expect(
      parsePipelineNumber("https://ci.dssconsulting.id/repos/2/pipeline/7", "2")
    ).toBe(7);
    // The host is not checked: the connection's base URL is internal.
    expect(
      parsePipelineNumber("http://woodpecker:8000/repos/12/pipeline/345", "12")
    ).toBe(345);
  });

  it("rejects another repo's pipeline", () => {
    expect(
      parsePipelineNumber("https://ci.dssconsulting.id/repos/3/pipeline/7", "2")
    ).toBeNull();
    expect(
      parsePipelineNumber(
        "https://ci.dssconsulting.id/repos/22/pipeline/7",
        "2"
      )
    ).toBeNull();
  });

  it("rejects a missing URL or a missing repo id", () => {
    expect(parsePipelineNumber(null, "2")).toBeNull();
    expect(parsePipelineNumber(undefined, "2")).toBeNull();
    expect(
      parsePipelineNumber(
        "https://ci.dssconsulting.id/repos/2/pipeline/7",
        null
      )
    ).toBeNull();
    expect(
      parsePipelineNumber("https://ci.dssconsulting.id/repos/2/pipeline/7", "")
    ).toBeNull();
  });

  it("rejects any other shape", () => {
    for (const url of [
      "https://ci.dssconsulting.id/repos/2/pipeline/abc",
      "https://ci.dssconsulting.id/repos/2/pipeline/7a",
      "https://ci.dssconsulting.id/repos/2/pipeline/-7",
      "https://ci.dssconsulting.id/repos/2/pipeline/0",
      "https://ci.dssconsulting.id/repos/2/pipeline/",
      "https://ci.dssconsulting.id/repos/2/pipeline/7/",
      "https://ci.dssconsulting.id/repos/2/pipeline/7/debug",
      "https://ci.dssconsulting.id/x/repos/2/pipeline/7",
      "https://ci.dssconsulting.id/repos/2/pipelines/7",
      "https://ci.dssconsulting.id/repos/2/pipeline/7?x=1",
      "https://ci.dssconsulting.id/repos/2/pipeline/99999999999999999999",
      "https://ci.dssconsulting.id/repos/%32/pipeline/7",
      "ftp://ci.dssconsulting.id/repos/2/pipeline/7",
      "not a url",
      "",
    ]) {
      expect(parsePipelineNumber(url, "2"), url).toBeNull();
    }
  });
});

describe("verifyWoodpeckerToken", () => {
  it("calls the current-user endpoint with the bearer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await verifyWoodpeckerToken(`${BASE}/`, TOKEN, impl);
    expect(calls[0]?.url).toBe(`${BASE}/api/user`);
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`
    );
  });

  it("throws a CiProviderError with the status, never the token", async () => {
    const impl = (async () =>
      new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const error = await verifyWoodpeckerToken(BASE, TOKEN, impl).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(CiProviderError);
    expect(error.status).toBe(403);
    expect(error.message).not.toContain(TOKEN);
  });
});
