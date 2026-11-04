import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { verifyWoodpeckerSignature } from "@/lib/ci/http-signature";
import { generateWoodpeckerPipeline } from "@/lib/ci/pipeline";
import { uuidSchema } from "@/lib/validation";
import { publicRouter } from "@/server/router";
import {
  findComponentByCiRepo,
  findExtensionKey,
} from "@/server/services/ci-config";

/**
 * Woodpecker sends the repo's own config files along (and possibly netrc);
 * a request near this size is not a pipeline config request.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** The fields read from Woodpecker's request; the rest is ignored. */
const extensionRequestSchema = z.object({
  repo: z.object({ id: z.union([z.number().int(), z.string().min(1)]) }),
});

/**
 * Woodpecker's configuration extension (one endpoint per CI connection). Public:
 * Woodpecker has no session; its ed25519 HTTP message signature, checked with
 * the connection's cached public key over the raw body bytes, is the
 * credential.
 *
 * An unknown connection and a bad signature get the same 401. A repo the Panel
 * does not know, a component in `custom` mode, or a pipeline that cannot be
 * generated answer 204, so Woodpecker keeps the repo's own file without
 * logging an error. Request bodies are never logged: they may carry netrc
 * credentials.
 */
export const ciConfigRouter = publicRouter().post(
  "/:connectionId",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  }),
  async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);

    const connectionId = uuidSchema.safeParse(c.req.param("connectionId"));
    if (!connectionId.success) return unauthorized();
    const connection = await findExtensionKey(connectionId.data);
    if (!connection) return unauthorized();
    if (!connection.publicKeyPem) {
      return c.json({ error: "Extension key not configured" }, 503);
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    const check = verifyWoodpeckerSignature(
      {
        method: c.req.method,
        url: c.req.url,
        headers: c.req.raw.headers,
        body,
      },
      connection.publicKeyPem
    );
    if (!check.ok) return unauthorized();

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return c.json({ error: "Invalid request" }, 400);
    }
    const request = extensionRequestSchema.safeParse(payload);
    if (!request.success) return c.json({ error: "Invalid request" }, 400);

    const component = await findComponentByCiRepo(
      connectionId.data,
      String(request.data.repo.id)
    );
    if (component?.pipelineMode !== "generated" || !component.buildSpec) {
      return c.body(null, 204);
    }

    let data: string;
    try {
      data = generateWoodpeckerPipeline(
        component.componentKey,
        component.buildSpec
      );
    } catch (error) {
      console.warn(
        `CI config extension: cannot generate the pipeline of component ${component.componentKey}; Woodpecker keeps the repo file:`,
        error instanceof Error ? error.message : error
      );
      return c.body(null, 204);
    }
    return c.json({ configs: [{ name: ".woodpecker.yaml", data }] }, 200);
  }
);
