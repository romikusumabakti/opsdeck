import { defineConfig, devices } from "@playwright/test";

// Port 3000 is often taken by something else on a dev machine, so the suite's
// server listens on E2E_PORT (default 3000, which is what CI uses).
const port = Number(process.env.E2E_PORT ?? 3000);
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // The specs share one database and one admin account, and auth.spec.ts
  // creates that account: run them in order, in one worker.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
  },
  projects: [
    // Creates the first admin and saves its session; everything else reuses
    // that session, so it has to run (and pass) first.
    {
      name: "auth",
      testMatch: "auth.spec.ts",
      // Setup creates the first admin; a retry would run against a database
      // that already has one and could never pass.
      retries: 0,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: "auth.spec.ts",
      dependencies: ["auth"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Reset and migrate the database first (e2e/reset-db.ts, guarded to
    // loopback *_e2e databases), so nothing is connected while the schema is
    // dropped: Playwright starts webServer before globalSetup, so the reset
    // can't live there. Then the production build, since that is what ships.
    command:
      "bun --no-env-file e2e/reset-db.ts && bun run build && bun run start",
    url: `${origin}/api/health`,
    // A leftover server would be talking to some other database (or be some
    // other program entirely), so reuse is opt-in. Reusing one also skips the
    // command, database reset included: the specs then need a fresh database
    // (auth.spec.ts creates the first admin).
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      PORT: String(port),
      // Must equal the page origin: better-auth's origin/CSRF checks compare
      // against it, and the dev-only trusted origins are off in production.
      BETTER_AUTH_URL: origin,
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      BETTER_AUTH_SECRET: "e2e-secret-not-used-anywhere-else",
      // 32 zero bytes, base64.
      SECRETS_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      ALLOWED_EMAIL_DOMAIN: "example.com",
      // Optional features stay off, even when a developer's .env.local (which
      // `bun run` loads) configures them: blank beats inherited.
      RESEND_API_KEY: "",
      MICROSOFT_CLIENT_ID: "",
      MICROSOFT_CLIENT_SECRET: "",
      MICROSOFT_TENANT_ID: "",
      S3_ENDPOINT: "",
      S3_BUCKET: "",
      S3_ACCESS_KEY: "",
      S3_SECRET_KEY: "",
      IMGPROXY_URL: "",
      IMGPROXY_KEY: "",
      IMGPROXY_SALT: "",
    },
  },
});
