// @vitest-environment happy-dom
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapQuery, meQuery, resetSession } from "@/web/api/session";
import { createQueryClient } from "@/web/query-client";

const bootstrap = { appName: "Panel", brand: "default" };
const oldUser = {
  user: { id: "u1" },
  orgRole: "member",
  timeZone: "Europe/Paris",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// The session wrappers fetch through the app's API client; answer `/api/me`
// as the server does once the session changed, and count every request.
function stubApi(me: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/me")) return Response.json(me);
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// A cache as the app leaves it: loaded through the real query options (so
// bootstrap carries its `fixed` meta), with fetchers that need no network.
async function primed() {
  const client = createQueryClient();
  await client.query({ ...meQuery(), queryFn: async () => oldUser as never });
  await client.query({
    ...bootstrapQuery(),
    queryFn: async () => bootstrap as never,
  });
  await client.query({
    queryKey: ["servers", "getServers", []],
    queryFn: async () => [{ id: "s1" }],
  });
  return client;
}

describe("resetSession", () => {
  it("tells components already subscribed to /api/me about the new user", async () => {
    const fetchMock = stubApi(null);
    const client = await primed();
    const observer = new QueryObserver(client, meQuery());
    const seen: unknown[] = [];
    const unsubscribe = observer.subscribe((result) => seen.push(result.data));

    await expect(resetSession(client)).resolves.toBeNull();

    expect(observer.getCurrentResult().data).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps the fixed bootstrap and drops the previous session's data", async () => {
    const fetchMock = stubApi(null);
    const client = await primed();

    await resetSession(client);

    expect(client.getQueryData(bootstrapQuery().queryKey)).toEqual(bootstrap);
    expect(client.getQueryData(["servers", "getServers", []])).toBeUndefined();
    // Only /api/me went over the wire: bootstrap was not refetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/me");
  });
});
