import { bodyLimit } from "hono/body-limit";
import { getDeployApp } from "@/lib/deploy/repository";
import { verifySignature } from "@/lib/deploy/signature";
import { appKeySchema } from "@/lib/deploy/validation";
import { publicRouter } from "@/server/router";
import {
  buildNotificationSchema,
  recordBuild,
} from "@/server/services/deploy-builds";

/** A notification is ~300 bytes; anything near this is not from our CI. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Verified against when the app is unknown, so an unknown app costs the same
 * HMAC as a known one and the response time does not reveal which app keys
 * exist. Never matches: no real secret is this value.
 */
const UNKNOWN_APP_SECRET = "opsdeck-unknown-app-dummy-secret";

/**
 * Build notifications from CI (Woodpecker), posted after the images are
 * pushed. Public: CI has no session. The credential is the per-app HMAC of the
 * raw body in `X-Opsdeck-Signature` (lib/deploy/signature.ts).
 *
 * The body is read once, as text, and the signature is checked over exactly
 * those bytes before any field but `app` is trusted. An unknown app, a missing
 * or malformed header and a wrong signature all get the same 401, so a caller
 * cannot probe which app keys exist.
 *
 * CI must send `Content-Type: application/json`: the CSRF guard refuses a
 * text/plain or form POST that carries no matching Origin.
 */
export const deployHooksRouter = publicRouter().post(
  "/builds",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  }),
  async (c) => {
    if (!process.env.DEPLOY_REGISTRY) {
      return c.json({ error: "Deploy disabled" }, 503);
    }
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);
    const invalid = () => c.json({ error: "Invalid request" }, 400);

    const rawBody = await c.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return invalid();
    }

    const signature = c.req.header("X-Opsdeck-Signature");
    const appKey = appKeySchema.safeParse(
      (payload as { app?: unknown } | null)?.app
    );
    const app = appKey.success ? await getDeployApp(appKey.data) : null;
    if (!app) {
      verifySignature(rawBody, signature, UNKNOWN_APP_SECRET);
      return unauthorized();
    }
    if (!verifySignature(rawBody, signature, app.notifySecretPlain)) {
      return unauthorized();
    }

    const notification = buildNotificationSchema.safeParse(payload);
    if (!notification.success) return invalid();

    return c.json(await recordBuild(notification.data), 202);
  }
);
