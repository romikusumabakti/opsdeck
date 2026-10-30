import type { Context } from "hono";
import { csrf } from "hono/csrf";

// Cross-site request forgery guard for every state-changing request.
//
// Next server actions refused a POST whose Origin didn't match the host; the
// API needs the same, because a bodyless POST (mark-all-notifications-read,
// clear-status) or a form-encoded one can be fired by a plain <form> on any
// site, with the user's cookie attached.
//
// hono/csrf only looks at requests a form can send — non-GET/HEAD with a
// form-encoded, multipart or text/plain body (a missing Content-Type counts as
// text/plain). JSON can't come from a form, so JSON callers that send no Origin
// — the Jira webhook — pass untouched. A checked request passes when the
// browser says `Sec-Fetch-Site: same-origin`, or when its Origin is the app's.
//
// The app's origin is BETTER_AUTH_URL's, the public URL auth already builds its
// callbacks from: behind the tunnel and Caddy the request URL is the
// container's, so comparing against it would refuse every real user. Unset (a
// local `bun run dev:server`) falls back to the request URL's own origin, which
// is what the browser sees there. Read per request, so the value tracks the
// environment the process runs in rather than whatever it was at import.
function appOrigin(c: Context): string {
  const configured = process.env.BETTER_AUTH_URL;
  return configured ? new URL(configured).origin : new URL(c.req.url).origin;
}

export const csrfGuard = csrf({
  origin: (origin, c) => origin === appOrigin(c),
});
