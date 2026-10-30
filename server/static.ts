import { join } from "node:path";
import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { MiddlewareHandler } from "hono/types";
import { defaultAccent } from "@/lib/accents";
import { APP_NAME, brand } from "@/lib/branding";
import { resolveRedirect } from "@/lib/redirects";
import type { AppEnv } from "@/server/context";
import { preferredLocale } from "@/server/middleware/locale";

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

// Never pages: the API, the favicon route and the built assets.
const NOT_PAGES = /^\/(api|brand|assets)(?=\/|$)/;

// Content-hashed by Vite, so a URL's bytes never change.
const IMMUTABLE = "public, max-age=31536000, immutable";

// Serve a file under `root` if one exists. A path ending in `/` is never a file
// here; serveStatic would answer it with the directory's index.html, which for
// `/` would skip the locale redirect.
function files(root: string): MiddlewareHandler {
  const serve = serveStatic({ root });
  return (c, next) => (c.req.path.endsWith("/") ? next() : serve(c, next));
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * index.html with this deployment's branding filled in: the runtime APP_NAME
 * as the <title>, and `data-brand` / `data-accent` (the brand's default) on
 * <html>. The build can't know them (lib/branding.ts reads the environment at
 * runtime), and the SPA only applies them once /api/bootstrap answers, so
 * without this the first paint shows the generic title and palette.
 */
export function brandShell(html: string): string {
  const logo = brand();
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(APP_NAME)}</title>`)
    .replace(
      /<html\b/,
      `<html data-brand="${escapeHtml(logo)}" data-accent="${escapeHtml(defaultAccent(logo))}"`
    );
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

  // Read once: a deploy replaces the process along with the build.
  let shell: Promise<string> | undefined;
  const serveShell = async (c: Context<AppEnv>) => {
    shell ??= Bun.file(join(clientDir, "index.html"))
      .text()
      .then(brandShell)
      .catch((error: unknown) => {
        shell = undefined;
        throw error;
      });
    c.header("Cache-Control", "no-cache");
    return c.body(await shell, 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  };

  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("Cache-Control", IMMUTABLE);
  });
  app.get("/assets/*", files(clientDir), (c) => c.notFound());
  // The shell itself, whichever way it is asked for: branded, and revalidated
  // on every load, so a deploy's new asset hashes are picked up at once.
  app.get("/index.html", (c) => serveShell(c));
  app.get("*", files(clientDir), files(publicDir), async (c) => {
    // A miss under a non-page prefix is a 404, not the SPA: a script, image
    // or API client must never get index.html with a 200.
    if (NOT_PAGES.test(c.req.path)) return c.notFound();
    const redirect = resolveRedirect(
      c.req.path,
      preferredLocale(c.req.raw.headers)
    );
    if (redirect) {
      const query = new URL(c.req.url).search;
      return c.redirect(redirect.to + query, redirect.status);
    }
    return serveShell(c);
  });
}
