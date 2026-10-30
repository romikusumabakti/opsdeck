// First, before anything that reaches @better-auth/passkey: its certificate
// parser (@peculiar/x509 → tsyringe) needs the Reflect metadata polyfill
// installed when it loads. x509 imports the polyfill itself, but `bun build`
// evaluates that CommonJS side-effect import after the ES modules beside it,
// so the bundled server (dist/server/index.js) died at boot without this.
import "reflect-metadata";
import { validateEnv } from "@/lib/env";
import { startWorker } from "@/lib/jobs/worker";
import { app } from "@/server/app";
import { mountStatic } from "@/server/static";

// The server process. Two jobs besides serving requests:
//
//  1. Validate the environment and refuse to boot on a fatal misconfiguration,
//     rather than letting each consumer discover its own missing var whenever
//     it first happens to run (which for the background handlers means failing
//     inside a restore, not at deploy time).
//  2. Boot the in-process BullMQ worker that drains the background-task queue,
//     so the single app container both serves requests and processes jobs (no
//     separate worker service).
validateEnv();
startWorker();

// In production the same process serves the built SPA (server/static.ts).
mountStatic(app);

// Bun serves a default export with a `fetch` handler.
export default {
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  fetch: app.fetch,
  // Bun closes a connection after 10 s without traffic by default, which cuts
  // the SSE streams (run logs, mail events) mid-run. 0 disables the timeout.
  idleTimeout: 0,
};
