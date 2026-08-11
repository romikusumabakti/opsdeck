import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  // These three moved under /admin. Keep old bookmarks working; the locale
  // prefix is always present (routing.localePrefix === "always").
  async redirects() {
    return [
      {
        source: "/:locale/:section(users|jira|activity)/:rest*",
        destination: "/:locale/admin/:section/:rest*",
        permanent: false,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
