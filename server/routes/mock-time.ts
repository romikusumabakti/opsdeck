import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  advanceClock,
  advanceClockLegacy,
  freezeClock,
  getClockState,
  getClockStateLegacy,
  mockProjectTimeLegacy,
  resetClock,
  resetClockLegacy,
  travelClock,
} from "@/server/services/mock-time";
import { json, query } from "@/server/validation";

// Timestamps and durations are judged by the service, which answers with the
// message the mock-time form shows ("Invalid target timestamp"), so they are
// only bounded here.
const timestamp = z.string().max(64);
const duration = z.string().max(64);

const environmentIdQuery = query(z.object({ environmentId: uuidSchema }));
const environmentIdBody = json(z.object({ environmentId: uuidSchema }));

export const mockTimeRouter = sessionRouter()
  .get("/get-clock-state", environmentIdQuery, async (c) =>
    c.json(await getClockState(c.req.valid("query").environmentId))
  )
  .get("/get-clock-state-legacy", environmentIdQuery, async (c) =>
    c.json(await getClockStateLegacy(c.req.valid("query").environmentId))
  )
  .post(
    "/travel-clock",
    json(z.object({ environmentId: uuidSchema, target: timestamp })),
    async (c) => {
      const { environmentId, target } = c.req.valid("json");
      return c.json(await travelClock(environmentId, target));
    }
  )
  .post(
    "/freeze-clock",
    json(z.object({ environmentId: uuidSchema, at: timestamp.nullable() })),
    async (c) => {
      const { environmentId, at } = c.req.valid("json");
      return c.json(await freezeClock(environmentId, at));
    }
  )
  .post(
    "/advance-clock",
    json(z.object({ environmentId: uuidSchema, duration })),
    async (c) => {
      const { environmentId, duration } = c.req.valid("json");
      return c.json(await advanceClock(environmentId, duration));
    }
  )
  .post("/reset-clock", environmentIdBody, async (c) =>
    c.json(await resetClock(c.req.valid("json").environmentId))
  )
  .post(
    "/mock-project-time-legacy",
    json(z.object({ environmentId: uuidSchema, mockedAt: timestamp })),
    async (c) => {
      const { environmentId, mockedAt } = c.req.valid("json");
      return c.json(await mockProjectTimeLegacy(environmentId, mockedAt));
    }
  )
  .post(
    "/advance-clock-legacy",
    json(z.object({ environmentId: uuidSchema, duration })),
    async (c) => {
      const { environmentId, duration } = c.req.valid("json");
      return c.json(await advanceClockLegacy(environmentId, duration));
    }
  )
  .post("/reset-clock-legacy", environmentIdBody, async (c) =>
    c.json(await resetClockLegacy(c.req.valid("json").environmentId))
  );
