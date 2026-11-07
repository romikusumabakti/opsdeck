import { STATUS_CODES } from "node:http";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Guards and services deny by throwing, so a check deep inside a helper aborts
// the whole request without every caller threading a status back up. `onError`
// below is the one place those throws become responses.

// A well-formed request the server still refuses (e.g. a reference that fails
// a business rule). `message` reaches the user as-is, so pass translated text.
export function badRequest(message: string, code?: string): never {
  if (code) throw new CodedHTTPException(400, code, message);
  throw new HTTPException(400, { message });
}

/**
 * A refusal that also names the rule it comes from by a stable code (an
 * actionErrors key, a DOMAIN_ERRORS key, …). The message is what it always
 * was; the code lets the setup preview report the same check as an issue and
 * the client tell refusals apart without matching text.
 */
export class CodedHTTPException extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string
  ) {
    super(status, { message });
    this.name = "CodedHTTPException";
  }
}

/** The stable code of a coded refusal (also a coded ForbiddenError), else undefined. */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof HTTPException)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

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
// parse. An HTTPException thrown without a message (hono/csrf's 403, for one)
// gets its status's standard text ("Forbidden"), which is what the client then
// shows. Anything that is not an HTTPException is a bug: log it, and answer
// with a generic 500 so internals (SQL, stack traces, file paths) never reach
// the browser.
export const onError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) {
    const message =
      error.message || STATUS_CODES[error.status] || `HTTP ${error.status}`;
    return c.json({ error: message }, error.status);
  }
  console.error(error);
  return c.json({ error: "Internal Server Error" }, 500);
};
