import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

// Guards and services deny by throwing, so a check deep inside a helper aborts
// the whole request without every caller threading a status back up. `onError`
// below is the one place those throws become responses.

export function unauthorized(): never {
  throw new HTTPException(401, { message: "Unauthorized" });
}

export function forbidden(): never {
  throw new HTTPException(403, { message: "Forbidden" });
}

export function notFound(): never {
  throw new HTTPException(404, { message: "Not Found" });
}

// Every API error is `{ error }` with the status, so the client has one shape to
// parse. Anything that is not an HTTPException is a bug: log it, and answer with
// a generic 500 so internals (SQL, stack traces, file paths) never reach the
// browser.
export const onError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) {
    return c.json(
      { error: error.message || `HTTP ${error.status}` },
      error.status
    );
  }
  console.error(error);
  return c.json({ error: "Internal Server Error" }, 500);
};
