/**
 * Bundles server/index.ts into dist/server (or the directory given as the
 * first argument), like `bun build server/index.ts --target=bun --outdir
 * dist/server`, plus one plugin the CLI cannot take.
 *
 * Why: the runtime image ships no node_modules, and jsdom (the DOM DOMPurify
 * runs on in lib/svg-sanitize) resolves its sync-XHR worker file at load time
 * with `require.resolve("./xhr-sync-worker.js")`. Bun bakes that into the
 * bundle as an absolute path on the build machine, so loading jsdom in the
 * image throws "Cannot find module". The sanitizer never makes a synchronous
 * XMLHttpRequest, so that one call is replaced with `null`. The build fails
 * if jsdom stops containing it, so an upgrade cannot silently undo this.
 */
import type { BunPlugin } from "bun";

const JSDOM_XHR_IMPL =
  /[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/;
const SYNC_WORKER_RESOLVE = 'require.resolve("./xhr-sync-worker.js")';

export const jsdomNoSyncXhrWorker: BunPlugin = {
  name: "jsdom-no-sync-xhr-worker",
  setup(build) {
    build.onLoad({ filter: JSDOM_XHR_IMPL }, async (args) => {
      const source = await Bun.file(args.path).text();
      if (!source.includes(SYNC_WORKER_RESOLVE)) {
        throw new Error(
          `${args.path} no longer contains ${SYNC_WORKER_RESOLVE}; revisit scripts/build-server.ts`
        );
      }
      return {
        contents: source.replace(SYNC_WORKER_RESOLVE, "null"),
        loader: "js",
      };
    });
  },
};

if (import.meta.main) {
  const outdir = process.argv[2] ?? "dist/server";
  const result = await Bun.build({
    entrypoints: ["server/index.ts"],
    target: "bun",
    outdir,
    define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
    plugins: [jsdomNoSyncXhrWorker],
  });
  for (const log of result.logs) console.error(log);
  if (!result.success) process.exit(1);
  for (const output of result.outputs) console.log(output.path);
}
