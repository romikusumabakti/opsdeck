import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiFetch, orFailure } from "@/web/api/client";
import { invalidateAfterMutation, ME_QUERY_KEY } from "@/web/query-client";

function setup(response: Response, pathname = "/en/servers", search = "") {
  const queryClient = new QueryClient();
  const invalidate = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined);
  const navigate = vi.fn();
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    response.clone()
  );
  const apiFetch = createApiFetch({
    queryClient,
    navigate,
    location: () => ({ pathname, search }),
    fetch,
  });
  return { apiFetch, invalidate, navigate, fetch, queryClient };
}

const ok = () => Response.json({ success: true });

describe("apiFetch", () => {
  it("states the route's locale in X-Locale", async () => {
    const { apiFetch, fetch } = setup(ok(), "/id/servers");
    await apiFetch("/api/labels/list-labels");
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("x-locale")).toBe("id");
  });

  it("falls back to the default locale off a locale route", async () => {
    const { apiFetch, fetch } = setup(ok(), "/");
    await apiFetch("/api/labels/list-labels");
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("x-locale")).toBe("en");
  });

  // revalidatePath("/", "layout") used to refresh every server component
  // after an action; a successful mutation now refreshes every query.
  it("invalidates queries once after a successful POST", async () => {
    const { apiFetch, invalidate } = setup(ok());
    await apiFetch("/api/notifications/mark-all-notifications-read", {
      method: "POST",
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not invalidate after a GET", async () => {
    const { apiFetch, invalidate } = setup(ok());
    await apiFetch("/api/labels/list-labels", { method: "GET" });
    await apiFetch("/api/labels/list-labels");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate after a failed POST", async () => {
    const { apiFetch, invalidate } = setup(
      Response.json({ error: "Invalid request" }, { status: 400 })
    );
    await expect(
      apiFetch("/api/issues/create-issue", { method: "POST" })
    ).rejects.toBeInstanceOf(ApiError);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("sends a 401 to sign-in with the current path", async () => {
    const { apiFetch, navigate } = setup(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    await expect(apiFetch("/api/servers/get-servers")).rejects.toMatchObject({
      status: 401,
    });
    expect(navigate).toHaveBeenCalledWith("/en/sign-in?redirect=%2Fservers");
  });

  // A revoked session must not survive in the cache: the $locale gate and the
  // shell read `/api/me` from it.
  it("forgets the cached user on a 401", async () => {
    const { apiFetch, queryClient } = setup(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    queryClient.setQueryData(ME_QUERY_KEY, { user: { id: "u1" } });
    await expect(apiFetch("/api/servers/get-servers")).rejects.toThrow();
    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeNull();
  });

  it("keeps the query string in the sign-in redirect", async () => {
    const { apiFetch, navigate } = setup(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
      "/id/issues",
      "?status=open"
    );
    await expect(apiFetch("/api/issues/list-all-issues")).rejects.toThrow();
    expect(navigate).toHaveBeenCalledWith(
      "/id/sign-in?redirect=%2Fissues%3Fstatus%3Dopen"
    );
  });

  // A 401 on a public page (a failed sign-in, an expired invite) is the
  // page's own error to show, not a reason to bounce to sign-in again.
  it("does not navigate on a 401 from a public page", async () => {
    const { apiFetch, navigate } = setup(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
      "/en/sign-in"
    );
    await expect(apiFetch("/api/me")).rejects.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("throws ApiError with the server's status and message", async () => {
    const { apiFetch } = setup(
      Response.json({ error: "Internal Server Error" }, { status: 500 })
    );
    const error = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 500,
      message: "Internal Server Error",
    });
  });

  it("falls back to the status text for a non-JSON error body", async () => {
    const { apiFetch } = setup(
      new Response("nope", { status: 502, statusText: "Bad Gateway" })
    );
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      status: 502,
      message: "Bad Gateway",
    });
  });
});

// The wrappers' error contract (web/api/client.ts, rule 1): an action that
// returned a result union keeps doing so, so `if (!res.success)` still fires.
describe("orFailure", () => {
  type Result = { success: true } | { success: false; message: string };
  const fail = (message: string): Result => ({ success: false, message });

  it("turns an ApiError into the action's failure result", async () => {
    const result = await orFailure<Result>(async () => {
      throw new ApiError(400, "Invalid request");
    }, fail);
    expect(result).toEqual({ success: false, message: "Invalid request" });
  });

  it("passes a success through", async () => {
    const ok: Result = { success: true };
    expect(await orFailure<Result>(async () => ok, fail)).toBe(ok);
  });

  // The page is already on its way to sign-in; it must not flash an error.
  it("still rejects on a 401", async () => {
    await expect(
      orFailure<Result>(async () => {
        throw new ApiError(401, "Unauthorized");
      }, fail)
    ).rejects.toMatchObject({ status: 401 });
  });

  it("does not swallow other errors", async () => {
    await expect(
      orFailure<Result>(async () => {
        throw new TypeError("Failed to fetch");
      }, fail)
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("invalidateAfterMutation", () => {
  function cache() {
    const client = new QueryClient();
    const seed = (key: string[], meta?: Record<string, boolean>) =>
      client.getQueryCache().build(client, { queryKey: key, meta }).setData(1);
    seed(["labels", "listLabels"]);
    seed(["session", "getBootstrap"], { fixed: true });
    seed(["backups", "getBackupList"], { remoteProbe: true });
    return client;
  }
  const stale = (client: QueryClient, key: string[]) =>
    client.getQueryState(key)?.isInvalidated;

  it("skips the bootstrap and other modules' remote probes", async () => {
    const client = cache();
    await invalidateAfterMutation(client, "/api/labels/set-issue-labels");
    expect(stale(client, ["labels", "listLabels"])).toBe(true);
    expect(stale(client, ["session", "getBootstrap"])).toBe(false);
    expect(stale(client, ["backups", "getBackupList"])).toBe(false);
  });

  it("refetches a remote probe after its own module's mutation", async () => {
    const client = cache();
    await invalidateAfterMutation(
      client,
      "/api/backups/create-database-backup"
    );
    expect(stale(client, ["backups", "getBackupList"])).toBe(true);
  });
});
