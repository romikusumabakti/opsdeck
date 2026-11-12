import { sessionRouter } from "@/server/router";

// One-release compatibility stub: a SPA bundle cached from before the
// milestones removal still calls this endpoint from the project Issues and
// issue detail loaders, and a 404 there fails the whole route until a full
// reload. Remove with the milestones drop (plan Task 8).
export const milestonesCompatRouter = sessionRouter().get(
  "/list-milestones",
  (c) => c.json([])
);
