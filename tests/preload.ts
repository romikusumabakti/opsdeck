// Test bootstrap, loaded by bunfig.toml before any test file.
//
// Bun has no per-file `environment` switch the way Vitest did, so everything
// vitest.config.ts used to declare lives here instead.

import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// "server-only" throws when imported outside a React Server Component. Several
// modules under lib/ import it purely as a guard; unit tests only want their
// pure exports, so stub it out at the module boundary.
mock.module("server-only", () => ({}));

// sanitizeEnvironment lives in lib/projects.ts, which imports lib/db — and that
// constructs a postgres client from DATABASE_URL at module load. postgres.js
// connects lazily, so a dummy URL is enough to import the module under test.
// `bun test` forces NODE_ENV=test and skips .env.local, so nothing here can
// pick up a real database by accident.
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/db";

// tests/knowledge-editor.test.ts constructs a Tiptap Editor, which reaches for
// window/document at construction time. Vitest got this from the
// `@vitest-environment jsdom` docblock; under Bun the DOM has to be registered
// before any test module is evaluated, which means globally.
GlobalRegistrator.register();
