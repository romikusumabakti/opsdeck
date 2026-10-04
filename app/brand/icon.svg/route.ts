import { renderBrandIcon } from "@/lib/brand-logos";
import { brand } from "@/lib/branding";

// The favicon follows BRAND, a runtime env var, so it is rendered per
// request rather than baked into the build. Skips proxy.ts (its matcher
// excludes *.svg), so the sign-in page gets it too.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(renderBrandIcon(brand()), {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=3600",
    },
  });
}
