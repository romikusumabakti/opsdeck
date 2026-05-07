import { Inngest } from "inngest";

// In dev, the SDK auto-targets the local dev server (port 8288) and accepts
// the literal key "local". Without this fallback the first `inngest.send()`
// throws "We couldn't find an event key" when the env var isn't set.
const eventKey =
  process.env.INNGEST_EVENT_KEY ??
  (process.env.NODE_ENV !== "production" ? "local" : undefined);

export const inngest = new Inngest({ id: "dss-panel", eventKey });
