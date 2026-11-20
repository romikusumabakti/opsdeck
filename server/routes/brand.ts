import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { type AccentColor, isAccent } from "@/lib/accents";
import { renderBrandIcon } from "@/lib/brand-logos";
import {
  getBranding,
  getBrandLogoBytes,
  type InstanceBranding,
} from "@/lib/instance-branding";
import type { AppEnv } from "@/server/context";
import { publicRouter } from "@/server/router";

/**
 * The instance logo and favicon. Public: the sign-in, 404 and error pages
 * show them too. A stored logo is an admin upload (SVG sanitized on upload,
 * raster re-encoded), served from the app's origin, so every answer here also
 * carries a sandbox CSP and nosniff: even opened directly, nothing in it runs
 * or loads. Responses revalidate (no-cache) against an ETag that names the
 * branding version, so a new logo shows on the next load.
 */

const BRAND_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "public, no-cache",
};

const brandHeaders = createMiddleware(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(BRAND_HEADERS)) {
    c.res.headers.set(name, value);
  }
});

const SVG = "image/svg+xml";

/** True when If-None-Match lists `etag` (weak or strong) or is `*`. */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

type Answer =
  | { kind: "stored"; theme: "light" | "dark"; etag: string }
  | { kind: "default"; accent: AccentColor; etag: string };

const stored = (b: InstanceBranding, theme: "light" | "dark"): Answer => ({
  kind: "stored",
  theme,
  etag: `"${b.version}-${theme}"`,
});

// The built-in mark's SVG per accent, with an ETag hashed from the bytes, so
// a change to the renderer (lib/brand-logos.ts) gives browsers a new tag.
const marks = new Map<AccentColor, { svg: string; etag: string }>();

function renderedMark(accent: AccentColor): { svg: string; etag: string } {
  let mark = marks.get(accent);
  if (!mark) {
    const svg = renderBrandIcon(accent);
    mark = { svg, etag: `"default-${accent}-${Bun.hash(svg).toString(36)}"` };
    marks.set(accent, mark);
  }
  return mark;
}

const defaultMark = (accent: AccentColor): Answer => ({
  kind: "default",
  accent,
  etag: renderedMark(accent).etag,
});

// The favicon PNG for a raster logo, resized once per branding version.
let iconPng: { version: string; bytes: Uint8Array } | null = null;

export const brandRouter = publicRouter()
  .use(brandHeaders)
  .get("/logo", async (c) => {
    const branding = await getBranding();
    const wantDark = c.req.query("theme") === "dark";
    const answer =
      wantDark && branding.logoDark
        ? stored(branding, "dark")
        : branding.logo
          ? stored(branding, "light")
          : defaultMark(branding.accent);
    return serve(c, answer);
  })
  // The favicon. The root layout links it with the user's `?accent=`, which
  // only tints the default mark; a custom logo is shown as uploaded.
  .get("/icon.svg", async (c) => {
    const branding = await getBranding();
    if (branding.logo?.type === SVG) {
      return serve(c, stored(branding, "light"));
    }
    if (branding.logo) return c.redirect("/brand/icon.png", 302);
    const param = c.req.query("accent");
    return serve(c, defaultMark(isAccent(param) ? param : branding.accent));
  })
  .get("/icon.png", async (c) => {
    const branding = await getBranding();
    if (!branding.logo || branding.logo.type === SVG) {
      return c.json({ error: "Not Found" }, 404);
    }
    const etag = `"${branding.version}-icon"`;
    if (matches(c.req.header("If-None-Match"), etag)) {
      return c.body(null, 304, { ETag: etag });
    }
    if (iconPng?.version !== branding.version) {
      const logo = await getBrandLogoBytes("light");
      if (!logo || logo.type === SVG)
        return c.json({ error: "Not Found" }, 404);
      const bytes = await new Bun.Image(logo.bytes)
        .resize(64, 64)
        .png()
        .bytes();
      iconPng = { version: branding.version, bytes };
    }
    return c.body(iconPng.bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "image/png",
      ETag: etag,
    });
  });

async function serve(c: Context<AppEnv>, answer: Answer) {
  if (matches(c.req.header("If-None-Match"), answer.etag)) {
    return c.body(null, 304, { ETag: answer.etag });
  }
  if (answer.kind === "default") {
    return c.body(renderedMark(answer.accent).svg, 200, {
      "Content-Type": SVG,
      ETag: answer.etag,
    });
  }
  const logo = await getBrandLogoBytes(answer.theme);
  if (!logo) return c.json({ error: "Not Found" }, 404);
  return c.body(logo.bytes as Uint8Array<ArrayBuffer>, 200, {
    "Content-Type": logo.type,
    ETag: answer.etag,
  });
}
