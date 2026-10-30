import { join } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { MiddlewareHandler } from "hono/types";
import { resolveRedirect } from "@/lib/redirects";
import type { AppEnv } from "@/server/context";

// Production serving of the built SPA, mounted after every API route so a
// route always wins over a file or the fallback. In development the Vite dev
// server owns pages and assets (proxying /api here), so only the API's JSON 404
// is mounted.
//
// Paths are relative to the working directory — the repo root locally, WORKDIR
// /app in the image — where `bun dist/server/index.js` is started.

type StaticOptions = {
  /** The Vite build output. */
  clientDir?: string;
  /** Files served as-is at the site root (motif SVGs). */
  publicDir?: string;
};

// Content-hashed by Vite, so a URL's bytes never change.
const IMMUTABLE = "public, max-age=31536000, immutable";

// Serve a file under `root` if one exists. A path ending in `/` is never a file
// here; serveStatic would answer it with the directory's index.html, which for
// `/` would skip the locale redirect.
function files(root: string): MiddlewareHandler {
  const serve = serveStatic({ root });
  return (c, next) => (c.req.path.endsWith("/") ? next() : serve(c, next));
}

export function mountStatic(
  app: Hono<AppEnv>,
  { clientDir = "./dist/client", publicDir = "./public" }: StaticOptions = {}
): void {
  // An unknown API path is a JSON error like every other API answer, never
  // the SPA: a client that parses JSON must not get index.html with a 200.
  app.notFound((c) =>
    c.req.path === "/api" || c.req.path.startsWith("/api/")
      ? c.json({ error: "Not Found" }, 404)
      : c.text("Not Found", 404)
  );

  if (process.env.NODE_ENV !== "production") return;

  const indexHtml = join(clientDir, "index.html");

  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("Cache-Control", IMMUTABLE);
  });
  app.get("/assets/*", files(clientDir), (c) => c.notFound());
  app.get("*", files(clientDir), files(publicDir), async (c) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      return c.notFound();
    }
    const redirect = resolveRedirect(c.req.path);
    if (redirect) {
      const query = new URL(c.req.url).search;
      return c.redirect(redirect.to + query, redirect.status);
    }
    // Revalidated on every load, so a deploy's new asset hashes are picked up
    // at once; the assets themselves are cached for good.
    c.header("Cache-Control", "no-cache");
    return c.body(await Bun.file(indexHtml).text(), 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  });
}
