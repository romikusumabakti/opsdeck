import { describe, expect, it, vi } from "vitest";
import { commitFile, getDefaultBranch } from "@/lib/ci/forges/bitbucket";
import { CiProviderError } from "@/lib/ci/types";

const AUTH = { username: "dev@example.test", token: "super-secret-token" };
const REPO = "acme/widgets";

function mockFetch(res: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return res;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const basic = (u: string, t: string) =>
  `Basic ${Buffer.from(`${u}:${t}`).toString("base64")}`;

describe("bitbucket commitFile", () => {
  it("posts multipart fields with Basic auth and parses the sha", async () => {
    const m = mockFetch(
      new Response(null, {
        status: 201,
        headers: {
          Location:
            "https://api.bitbucket.org/2.0/repositories/acme/widgets/commit/abc123def",
        },
      })
    );
    const out = await commitFile(
      AUTH,
      REPO,
      "main",
      ".woodpecker.yaml",
      "steps: []\n",
      "add pipeline",
      m.impl
    );
    expect(out).toEqual({ sha: "abc123def" });
    const call = m.calls[0] as (typeof m.calls)[number];
    expect(call.url).toBe(
      "https://api.bitbucket.org/2.0/repositories/acme/widgets/src"
    );
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("authorization")).toBe(
      basic(AUTH.username, AUTH.token)
    );
    const form = call.init.body as FormData;
    expect(form.get(".woodpecker.yaml")).toBeTruthy();
    expect(await (form.get(".woodpecker.yaml") as Blob).text()).toBe(
      "steps: []\n"
    );
    expect(form.get("message")).toBe("add pipeline");
    expect(form.get("branch")).toBe("main");
  });

  it("reports status and Bitbucket message without the token", async () => {
    const m = mockFetch(
      Response.json(
        { type: "error", error: { message: "You do not have access" } },
        { status: 403 }
      )
    );
    const err = await commitFile(AUTH, REPO, "main", "a", "b", "m", m.impl)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("403");
    expect(err.message).toContain("You do not have access");
    expect(err.message).not.toContain(AUTH.token);
  });

  it("hides transport errors", async () => {
    const impl = vi.fn(async () => {
      throw new Error(`boom ${AUTH.token}`);
    }) as unknown as typeof fetch;
    const err = await commitFile(AUTH, REPO, "main", "a", "b", "m", impl)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect(err.status).toBe(0);
    expect(err.message).not.toContain(AUTH.token);
  });

  it("fails when Location has no commit sha", async () => {
    const m = mockFetch(new Response(null, { status: 201 }));
    await expect(
      commitFile(AUTH, REPO, "main", "a", "b", "m", m.impl)
    ).rejects.toBeInstanceOf(CiProviderError);
  });
});

describe("bitbucket getDefaultBranch", () => {
  it("returns mainbranch.name", async () => {
    const m = mockFetch(Response.json({ mainbranch: { name: "develop" } }));
    expect(await getDefaultBranch(AUTH, REPO, m.impl)).toBe("develop");
    expect(m.calls[0]?.url).toBe(
      "https://api.bitbucket.org/2.0/repositories/acme/widgets"
    );
  });

  it("fails when the repo has no main branch", async () => {
    const m = mockFetch(Response.json({}));
    await expect(getDefaultBranch(AUTH, REPO, m.impl)).rejects.toBeInstanceOf(
      CiProviderError
    );
  });
});

describe("bitbucket input validation", () => {
  const never = () => {
    const impl = vi.fn();
    return { impl, fetchImpl: impl as unknown as typeof fetch };
  };

  it.each(["", "message", "branch", "/etc/x", "a/../b", "../x"])(
    "rejects path %j",
    async (path) => {
      const f = never();
      await expect(
        commitFile(AUTH, REPO, "main", path, "c", "m", f.fetchImpl)
      ).rejects.toThrow();
      expect(f.impl).not.toHaveBeenCalled();
    }
  );

  it.each(["", "ma in", "main\n", "a\tb", "a\u0000b"])(
    "rejects branch %j",
    async (branch) => {
      const f = never();
      await expect(
        commitFile(AUTH, REPO, branch, "a.yaml", "c", "m", f.fetchImpl)
      ).rejects.toThrow();
      expect(f.impl).not.toHaveBeenCalled();
    }
  );

  it.each([
    "acme",
    "acme/widgets/extra",
    "../widgets",
    "acme/..",
    "a b/c",
    "acme/w?x=1",
    "",
  ])("rejects repo %j in both functions", async (repo) => {
    const f = never();
    await expect(
      commitFile(AUTH, repo, "main", "a.yaml", "c", "m", f.fetchImpl)
    ).rejects.toThrow();
    await expect(getDefaultBranch(AUTH, repo, f.fetchImpl)).rejects.toThrow();
    expect(f.impl).not.toHaveBeenCalled();
  });

  it("truncates long error details to 300 characters", async () => {
    const m = mockFetch(
      Response.json(
        { type: "error", error: { message: "x".repeat(1000) } },
        { status: 500 }
      )
    );
    const err = await commitFile(AUTH, REPO, "main", "a", "b", "m", m.impl)
      .then(() => null)
      .catch((e) => e);
    expect(err.message).toContain("x".repeat(300));
    expect(err.message).not.toContain("x".repeat(301));
  });
});
