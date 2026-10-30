import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA. In development Vite serves it on its own port and proxies the API,
// the favicon and the terminal WebSocket to the Bun server (3000) and the
// terminal sidecar (3001), so the browser sees one origin as in production,
// where the Bun server serves dist/client itself (server/static.ts).
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
  resolve: {
    tsconfigPaths: true,
    // tsconfigPaths only maps files the tsconfig includes, and components/
    // and hooks/ are excluded until their Next imports are gone (Task 7).
    // Drop this alias once they are back in the tsconfig.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  build: { outDir: "dist/client" },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/brand": "http://localhost:3000",
      "/ws/terminal": { target: "ws://localhost:3001", ws: true },
    },
  },
});
