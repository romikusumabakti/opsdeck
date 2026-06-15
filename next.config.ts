import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  // The mock-time page reads docs/time-mocking-api.md at runtime via a dynamic
  // path, which Next's tracer can't follow. Without this it's absent from the
  // standalone output and the page throws ENOENT in production.
  outputFileTracingIncludes: {
    "/[locale]/projects/[projectId]/mock-time": ["./docs/**"],
  },
};

export default withNextIntl(nextConfig);
