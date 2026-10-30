import { defaultAccent, isAccent } from "@/lib/accents";
import { renderBrandIcon } from "@/lib/brand-logos";
import { brand } from "@/lib/branding";

// The favicon: BRAND picks the shape, ?accent= the colour (the root layout
// links /brand/icon.svg?accent=<user's accent>). A missing or unknown accent —
// the 404 and error pages link it bare — means the brand default. The output
// depends only on the URL and BRAND, so a public cache is safe. Skips proxy.ts
// (its matcher excludes *.svg), so the sign-in page gets it too.
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const param = new URL(request.url).searchParams.get("accent");
  const accent = isAccent(param) ? param : defaultAccent(brand());
  return new Response(renderBrandIcon(brand(), accent), {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=3600",
    },
  });
}
