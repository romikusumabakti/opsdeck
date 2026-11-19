import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny local stand-in for the Woodpecker API, so the services specs
 * register services without a real CI: it lists `repos`, activates one,
 * takes its settings and secrets, and answers pipeline calls with an empty
 * list or pipeline #1. Nothing is stored beyond what the answers need.
 */
export type WoodpeckerStub = {
  baseUrl: string;
  /** Every request as `METHOD /path`, for assertions. */
  calls: string[];
  close: () => Promise<void>;
};

export type StubRepo = { id: number; fullName: string; forgeRemoteId: string };

export async function startWoodpeckerStub(
  repos: readonly StubRepo[]
): Promise<WoodpeckerStub> {
  const calls: string[] = [];
  const active = new Set<number>();
  const asJson = (repo: StubRepo) => ({
    id: repo.id,
    full_name: repo.fullName,
    forge_remote_id: repo.forgeRemoteId,
    active: active.has(repo.id),
    default_branch: "main",
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    calls.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown = {}) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Drain the body; no route needs it.
    req.resume();
    req.on("end", () => {
      const path = url.pathname;
      if (req.method === "GET" && path === "/api/user") return send(200, {});
      if (req.method === "GET" && path === "/api/user/repos") {
        return send(200, repos.map(asJson));
      }
      if (req.method === "POST" && path === "/api/repos") {
        const repo = repos.find(
          (r) => r.forgeRemoteId === url.searchParams.get("forge_remote_id")
        );
        if (!repo) return send(404);
        if (active.has(repo.id)) return send(409);
        active.add(repo.id);
        return send(200, asJson(repo));
      }
      const lookup = /^\/api\/repos\/lookup\/(.+)$/.exec(path);
      if (req.method === "GET" && lookup) {
        const repo = repos.find((r) => r.fullName === lookup[1]);
        return repo ? send(200, asJson(repo)) : send(404);
      }
      if (/^\/api\/repos\/\d+$/.test(path) && req.method === "PATCH") {
        return send(200, {});
      }
      if (/^\/api\/repos\/\d+\/secrets\/[^/]+$/.test(path)) {
        return req.method === "GET" ? send(404) : send(200, {});
      }
      if (/^\/api\/repos\/\d+\/secrets$/.test(path)) return send(200, {});
      if (/^\/api\/repos\/\d+\/pipelines$/.test(path)) {
        return req.method === "POST" ? send(200, { number: 1 }) : send(200, []);
      }
      if (/^\/api\/repos\/\d+\/pipelines\/\d+$/.test(path)) {
        return send(200, {});
      }
      send(404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
