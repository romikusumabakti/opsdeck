import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import { getAccessMatrix, offboardUser } from "@/server/services/access";
import { json } from "@/server/validation";

export const accessRouter = sessionRouter()
  .get("/get-access-matrix", async (c) => c.json(await getAccessMatrix()))
  .post("/offboard-user", json(z.object({ userId: uuidSchema })), async (c) =>
    c.json(await offboardUser(c.req.valid("json").userId))
  );
