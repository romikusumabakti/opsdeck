import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // sanitizeProject lives in lib/projects.ts, which imports "server-only"
    // (a no-op outside the Next runtime) and lib/db (which constructs a
    // postgres client from DATABASE_URL at module load). Provide a dummy URL
    // so the pure functions under test can be imported without a real DB.
    env: {
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    },
  },
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" -> "./*" path mapping.
      "@": rootDir.replace(/\/$/, ""),
      // "server-only" throws if imported in a client/non-server context; in
      // unit tests we alias it to an empty module so importing server modules
      // for their pure exports doesn't blow up.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/empty.ts", import.meta.url)
      ),
    },
  },
});
