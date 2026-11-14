import { z } from "zod";

// Zod compiles object parsers with `new Function`. The page's
// Content-Security-Policy (server/middleware/security-headers.ts) forbids
// eval, so the probe would be reported as a violation even though Zod catches
// the failure. `jitless` skips the probe and uses the interpreted parsers.
//
// Imported first in main.tsx: it must run before any schema is built, and ES
// imports evaluate in order.
z.config({ jitless: true });
