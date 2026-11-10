import { z } from "zod";
import {
  adoptDomainInputSchema,
  domainInputSchema,
} from "@/lib/domains/validation";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  adoptEnvironmentDomain,
  deleteEnvironmentDomain,
  getEnvironmentDomain,
  listDomainAccessPolicies,
  putEnvironmentDomain,
} from "@/server/services/environment-domains";
import { json, param } from "@/server/validation";

const envParam = param(z.object({ id: uuidSchema }));

/**
 * An environment's domain, mounted at /api/environments. Each service
 * function checks its permission itself (adopt: org server:manage).
 */
export const environmentDomainsRouter = sessionRouter()
  .get("/:id/domain", envParam, async (c) =>
    c.json(await getEnvironmentDomain(c.req.valid("param").id))
  )
  .get("/:id/domain/access-policies", envParam, async (c) =>
    c.json(await listDomainAccessPolicies(c.req.valid("param").id))
  )
  .put("/:id/domain", envParam, json(domainInputSchema), async (c) =>
    c.json(
      await putEnvironmentDomain(c.req.valid("param").id, c.req.valid("json"))
    )
  )
  .post(
    "/:id/domain/adopt",
    envParam,
    json(adoptDomainInputSchema),
    async (c) =>
      c.json(
        await adoptEnvironmentDomain(
          c.req.valid("param").id,
          c.req.valid("json")
        )
      )
  )
  .delete("/:id/domain", envParam, async (c) => {
    await deleteEnvironmentDomain(c.req.valid("param").id);
    return c.json({ ok: true });
  });
