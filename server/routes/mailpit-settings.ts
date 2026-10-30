import { z } from "zod";
import { mailpitSettingsSchema, uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  getMailpitSettings,
  saveMailpitSettings,
  testMailpitConnection,
} from "@/server/services/mailpit-settings";
import { json, query } from "@/server/validation";

// The connection test answers a bad URL with the service's own message ("Enter
// a valid http(s) URL"), so its payload is only shape-checked and bounded.
const testInput = z.object({
  url: z.string().max(2048),
  username: z.string().max(255).nullish(),
  password: z.string().max(1024).optional(),
});

export const mailpitSettingsRouter = sessionRouter()
  .get(
    "/get-mailpit-settings",
    query(z.object({ environmentId: uuidSchema })),
    async (c) =>
      c.json(await getMailpitSettings(c.req.valid("query").environmentId))
  )
  .post(
    "/save-mailpit-settings",
    json(z.object({ environmentId: uuidSchema, data: mailpitSettingsSchema })),
    async (c) => {
      const { environmentId, data } = c.req.valid("json");
      return c.json(await saveMailpitSettings(environmentId, data));
    }
  )
  .post(
    "/test-mailpit-connection",
    json(z.object({ environmentId: uuidSchema, data: testInput })),
    async (c) => {
      const { environmentId, data } = c.req.valid("json");
      return c.json(await testMailpitConnection(environmentId, data));
    }
  );
