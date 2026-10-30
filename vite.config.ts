import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA. In development Vite serves it on its own port and proxies the API,
// the favicon and the terminal WebSocket to the Bun server (PORT, default
// 3000) and the terminal sidecar (3001), so the browser sees one origin as in production,
// where the Bun server serves dist/client itself (server/static.ts).
// Must match the port the Bun server listens on (`PORT`).
const api = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [
    // Before react(): it generates web/routeTree.gen.ts and splits each
    // route's component into its own chunk.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "web/routes",
      generatedRouteTree: "web/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: { tsconfigPaths: true },
  build: { outDir: "dist/client" },
  server: {
    proxy: {
      "/api": api,
      "/brand": api,
      "/ws/terminal": { target: "ws://localhost:3001", ws: true },
    },
  },
});
