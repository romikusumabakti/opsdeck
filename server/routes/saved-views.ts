import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
} from "@/server/services/saved-views";
import { json } from "@/server/validation";

export const savedViewsRouter = sessionRouter()
  .get("/list-saved-views", async (c) => c.json(await listSavedViews()))
  .post(
    "/create-saved-view",
    json(
      z.object({
        // The service trims and truncates the name; this only bounds the body.
        name: z.string().max(1000),
        // The issues page's filter params (see ISSUE_FILTER_KEYS).
        params: z.record(z.string().max(100), z.string().max(1000)),
      })
    ),
    async (c) => {
      const { name, params } = c.req.valid("json");
      return c.json(await createSavedView(name, params));
    }
  )
  .post("/delete-saved-view", json(z.object({ id: uuidSchema })), async (c) =>
    c.json(await deleteSavedView(c.req.valid("json").id))
  );
