import { bodyLimit } from "hono/body-limit";
import { getComponent } from "@/lib/apps";
import { verifySignature } from "@/lib/deploy/signature";
import { componentKeySchema } from "@/lib/deploy/validation";
import { decryptSecret } from "@/lib/secrets";
import { publicRouter } from "@/server/router";
import {
  buildNotificationSchema,
  recordBuild,
} from "@/server/services/deploy-builds";

/** A notification is ~300 bytes; anything near this is not from our CI. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Verified against when the component is unknown, so an unknown component
 * costs the same HMAC as a known one and the response time does not reveal
 * which component keys exist. Never matches: no real secret is this value.
 */
const UNKNOWN_COMPONENT_SECRET = "opsdeck-unknown-component-dummy-secret";

/**
 * The component's notify secret, or null when the component is unknown. A
 * secret that cannot be decrypted (a rotated SECRETS_KEY, a corrupt row) is
 * logged and treated like an unknown component, so it answers the same 401 rather than a 500.
 */
async function notifySecret(componentKey: string): Promise<string | null> {
  const component = await getComponent(componentKey);
  if (!component) return null;
  try {
    return decryptSecret(component.notifySecret);
  } catch (error) {
    console.error(
      `Deploy hook: cannot decrypt the notify secret of component ${componentKey}:`,
      error
    );
    return null;
  }
}

/**
 * Build notifications from CI (Woodpecker), posted after the images are
 * pushed. Public: CI has no session. The credential is the per-component HMAC of the
 * raw body in `X-Opsdeck-Signature` (lib/deploy/signature.ts).
 *
 * The body is read once, as text, and the signature is checked over exactly
 * those bytes before any field but `app` is trusted. The body field `app` holds
 * the component key (the name is kept for pipelines already in the field). An
 * unknown component, a missing or malformed header and a wrong signature all
 * get the same 401, so a caller cannot probe which component keys exist.
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
    const componentKey = componentKeySchema.safeParse(
      (payload as { app?: unknown } | null)?.app
    );
    const secret = componentKey.success
      ? await notifySecret(componentKey.data)
      : null;
    if (secret === null) {
      verifySignature(rawBody, signature, UNKNOWN_COMPONENT_SECRET);
      return unauthorized();
    }
    if (!verifySignature(rawBody, signature, secret)) {
      return unauthorized();
    }

    const notification = buildNotificationSchema.safeParse(payload);
    if (!notification.success) return invalid();

    return c.json(await recordBuild(notification.data), 202);
  }
);
