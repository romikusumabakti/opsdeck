import "server-only";

import { routeProjectGuard } from "@/lib/authz";
import { uuidSchema } from "@/lib/validation";
import type { MailpitConfig } from "./client";
import { loadMailpitConfig } from "./config";

// Route-handler twin of actions/mail#requireMail. Answers with a status code
// instead of redirecting: callers are downloads and EventSource, not pages.
export async function authorizeMailRoute(
  environmentId: string
): Promise<
  { ok: true; cfg: MailpitConfig } | { ok: false; response: Response }
> {
  if (!uuidSchema.safeParse(environmentId).success) {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }
  const guard = await routeProjectGuard({ environmentId }, { mail: ["read"] });
  if (!guard.ok) return guard;
  const cfg = await loadMailpitConfig(environmentId);
  if (!cfg) {
    return {
      ok: false,
      response: new Response("Mailpit is not configured", { status: 404 }),
    };
  }
  return { ok: true, cfg };
}
