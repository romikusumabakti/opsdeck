import { describe, expect, it, vi } from "vitest";
import { branchExists, commitFile } from "@/lib/ci/forges/bitbucket";
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

describe("bitbucket transport hardening", () => {
  it("does not follow redirects and sets a 15 s timeout", async () => {
    const m = mockFetch(
      new Response(null, {
        status: 201,
        headers: {
          Location:
            "https://api.bitbucket.org/2.0/repositories/acme/widgets/commit/abc1234",
        },
      })
    );
    await commitFile(AUTH, REPO, "main", "a.yaml", "b", "m", m.impl);
    const init = m.calls[0]?.init as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a redirect instead of following it", async () => {
    const m = mockFetch(
      new Response(null, {
        status: 302,
        headers: { Location: "https://id.atlassian.com/login" },
      })
    );
    const err = await commitFile(AUTH, REPO, "main", "a", "b", "m", m.impl)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect(err.status).toBe(302);
    expect(err.message).toBe(
      "Bitbucket POST acme/widgets/src redirected — check the URL/Access"
    );
    expect(m.calls).toHaveLength(1);
  });

  it("reports a timeout with a fixed message and status 0", async () => {
    const impl = vi.fn(async () => {
      throw new DOMException(`timed out ${AUTH.token}`, "TimeoutError");
    }) as unknown as typeof fetch;
    const err = await commitFile(AUTH, REPO, "main", "a", "b", "m", impl)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect(err.status).toBe(0);
    expect(err.message).toBe("Bitbucket POST acme/widgets/src timed out");
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
  ])("rejects repo %j", async (repo) => {
    const f = never();
    await expect(
      commitFile(AUTH, repo, "main", "a.yaml", "c", "m", f.fetchImpl)
    ).rejects.toThrow();
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

describe("bitbucket branchExists", () => {
  it("is true on 200 and encodes the branch name", async () => {
    const m = mockFetch(new Response("{}", { status: 200 }));
    expect(await branchExists(AUTH, REPO, "feature/x", m.impl)).toBe(true);
    const call = m.calls[0] as (typeof m.calls)[number];
    expect(call.url).toBe(
      "https://api.bitbucket.org/2.0/repositories/acme/widgets/refs/branches/feature%2Fx"
    );
    expect(call.init.method).toBe("GET");
  });

  it("is false on 404", async () => {
    const m = mockFetch(new Response("{}", { status: 404 }));
    expect(await branchExists(AUTH, REPO, "gone", m.impl)).toBe(false);
  });

  it("throws CiProviderError on other statuses", async () => {
    const m = mockFetch(new Response("{}", { status: 500 }));
    const err = await branchExists(AUTH, REPO, "main", m.impl)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CiProviderError);
    expect(err.status).toBe(500);
  });

  it("rejects invalid branch names before fetching", async () => {
    const m = mockFetch(new Response("{}", { status: 200 }));
    await expect(branchExists(AUTH, REPO, "a b", m.impl)).rejects.toThrow(
      /Invalid branch name/
    );
    expect(m.calls).toHaveLength(0);
  });
});
