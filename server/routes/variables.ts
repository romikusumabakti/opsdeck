import { z } from "zod";
import { appKeySchema } from "@/lib/deploy/validation";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  applyTemplate,
  deleteVariable,
  deleteVariableTemplate,
  listVariables,
  listVariableTemplates,
  putVariable,
  putVariableTemplate,
  regenerateVariable,
  setEnvFileManaged,
  templateInputSchema,
  variableInputSchema,
} from "@/server/services/variables";
import { json, param, query } from "@/server/validation";

// Names are checked in full by the service (the reserved tag names depend on
// the environment); the route only bounds them.
const nameParam = z.string().min(1).max(128);
const envParam = param(z.object({ id: uuidSchema }));
const variableParam = param(z.object({ id: uuidSchema, name: nameParam }));

// A revealed listing holds decrypted secrets: never cache it.
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * An environment's variables, mounted at /api/environments. Each service
 * function checks `variable:read` / `variable:write` (owner-aware) itself.
 */
export const environmentVariablesRouter = sessionRouter()
  .get(
    "/:id/variables",
    envParam,
    query(z.object({ reveal: z.enum(["0", "1"]).optional() })),
    async (c) => {
      const reveal = c.req.valid("query").reveal === "1";
      const result = await listVariables(c.req.valid("param").id, { reveal });
      return c.json(result, 200, reveal ? NO_STORE : undefined);
    }
  )
  // Before /:name routes of the same method, so the literal path wins.
  .post("/:id/variables/apply-template", envParam, async (c) =>
    c.json(await applyTemplate(c.req.valid("param").id))
  )
  .put(
    "/:id/variables/:name",
    variableParam,
    json(variableInputSchema),
    async (c) => {
      const { id, name } = c.req.valid("param");
      return c.json(await putVariable(id, name, c.req.valid("json")));
    }
  )
  .delete("/:id/variables/:name", variableParam, async (c) => {
    const { id, name } = c.req.valid("param");
    await deleteVariable(id, name);
    return c.json({ ok: true });
  })
  .post("/:id/variables/:name/regenerate", variableParam, async (c) => {
    const { id, name } = c.req.valid("param");
    return c.json(await regenerateVariable(id, name));
  })
  .patch(
    "/:id/env-file-managed",
    envParam,
    json(z.object({ enabled: z.boolean() }).strict()),
    async (c) =>
      c.json(
        await setEnvFileManaged(
          c.req.valid("param").id,
          c.req.valid("json").enabled
        )
      )
  );

const appParam = param(z.object({ appKey: appKeySchema }));
const templateParam = param(
  z.object({ appKey: appKeySchema, name: nameParam })
);

/**
 * An app's variable templates, mounted at /api/apps; org
 * `integration:manage` (checked by the service).
 */
export const variableTemplatesRouter = sessionRouter()
  .get("/:appKey/variable-templates", appParam, async (c) =>
    c.json(await listVariableTemplates(c.req.valid("param").appKey))
  )
  .put(
    "/:appKey/variable-templates/:name",
    templateParam,
    json(templateInputSchema),
    async (c) => {
      const { appKey, name } = c.req.valid("param");
      return c.json(
        await putVariableTemplate(appKey, name, c.req.valid("json"))
      );
    }
  )
  .delete("/:appKey/variable-templates/:name", templateParam, async (c) => {
    const { appKey, name } = c.req.valid("param");
    await deleteVariableTemplate(appKey, name);
    return c.json({ ok: true });
  });
