import { renderBrandIcon } from "@/lib/brand-logos";
import { brandLogo } from "@/lib/branding";

// The favicon follows BRAND_LOGO, a runtime env var, so it is rendered per
// request rather than baked into the build. Skips proxy.ts (its matcher
// excludes *.svg), so the sign-in page gets it too.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(renderBrandIcon(brandLogo()), {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=3600",
    },
  });
}
