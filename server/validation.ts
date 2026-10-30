import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";

// Request validators for the routers. Every failure is the same generic 400
// `{ error }` the rest of the API uses: zod's issue list would describe the
// expected payload to any caller, and the client never shows it anyway — forms
// validate with the same schemas before they submit.

function rejectInvalid(result: { success: boolean }, c: Context) {
  if (!result.success) return c.json({ error: "Invalid request" }, 400);
}

/** Validate the JSON body. Mutations name its keys after the service params. */
export function json<T extends z.ZodType>(schema: T) {
  return zValidator("json", schema, rejectInvalid);
}

/** Validate scalar query parameters (strings; coerce numbers in the schema). */
export function query<T extends z.ZodType>(schema: T) {
  return zValidator("query", schema, rejectInvalid);
}

/** Validate path parameters. */
export function param<T extends z.ZodType>(schema: T) {
  return zValidator("param", schema, rejectInvalid);
}

/**
 * Validate a read whose argument is not scalar (arrays, filter objects). It
 * travels as one `q` query parameter holding JSON, so the read stays a GET:
 * the client refetches every query after any non-GET 2xx, and a read sent as
 * POST would trigger that refetch itself — forever.
 *
 * The handler reads the parsed value with `c.req.valid("query")`.
 */
export function jsonQuery<T extends z.ZodType>(schema: T) {
  const fromJson = z
    .string()
    .transform((raw, ctx): unknown => {
      try {
        return JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);
  return zValidator(
    "query",
    // The generic hides `q` from zod's inferred object type; the cast restores
    // what the pipe guarantees.
    z.object({ q: fromJson }).transform((v) => (v as { q: z.output<T> }).q),
    rejectInvalid
  );
}
