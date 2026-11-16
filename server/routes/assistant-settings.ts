import { sessionRouter } from "@/server/router";
import {
  assistantSettingsInputSchema,
  assistantUsageQuerySchema,
  getAssistantSettings,
  getAssistantUsage,
  saveAssistantSettings,
  testAssistantConnection,
} from "@/server/services/assistant-settings";
import { json, query } from "@/server/validation";

/** Code assistant admin settings. Each service function checks assistant:manage. */
export const assistantSettingsRouter = sessionRouter()
  .get("/", async (c) => c.json(await getAssistantSettings()))
  .put("/", json(assistantSettingsInputSchema), async (c) =>
    c.json(await saveAssistantSettings(c.req.valid("json")))
  )
  .get("/usage", query(assistantUsageQuerySchema), async (c) =>
    c.json(await getAssistantUsage(c.req.valid("query")))
  )
  .post("/test", async (c) => c.json(await testAssistantConnection()));
