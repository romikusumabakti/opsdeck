import { defaultAccent, isAccent } from "@/lib/accents";
import { renderBrandIcon } from "@/lib/brand-logos";
import { brand } from "@/lib/branding";
import { publicRouter } from "@/server/router";

/**
 * The favicon, ported from app/brand/icon.svg. Public: the sign-in, 404 and
 * error pages link it too. BRAND picks the shape, `?accent=` the colour (the
 * root layout links /brand/icon.svg?accent=<user's accent>); a missing or
 * unknown accent means the brand default. The output depends only on the URL
 * and BRAND, so a public cache is safe.
 */
export const brandRouter = publicRouter().get("/icon.svg", (c) => {
  const param = c.req.query("accent");
  const accent = isAccent(param) ? param : defaultAccent();
  return c.body(renderBrandIcon(brand(), accent), 200, {
    "content-type": "image/svg+xml",
    "cache-control": "public, max-age=3600",
  });
});
