import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api["mock-time"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getClockState(environmentId: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["get-clock-state"].$get({ query: { environmentId } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export const getClockStateQuery = (...args: Parameters<typeof getClockState>) =>
  queryOptions({
    queryKey: ["mock-time", "getClockState", args],
    queryFn: () => getClockState(...args),
    ...REMOTE_PROBE,
  });

export async function getClockStateLegacy(environmentId: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["get-clock-state-legacy"].$get({ query: { environmentId } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export const getClockStateLegacyQuery = (
  ...args: Parameters<typeof getClockStateLegacy>
) =>
  queryOptions({
    queryKey: ["mock-time", "getClockStateLegacy", args],
    queryFn: () => getClockStateLegacy(...args),
    ...REMOTE_PROBE,
  });

export async function travelClock(
  environmentId: Body<"travel-clock">["environmentId"],
  target: Body<"travel-clock">["target"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["travel-clock"].$post({ json: { environmentId, target } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export async function freezeClock(
  environmentId: Body<"freeze-clock">["environmentId"],
  at: Body<"freeze-clock">["at"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["freeze-clock"].$post({ json: { environmentId, at } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export async function advanceClock(
  environmentId: Body<"advance-clock">["environmentId"],
  duration: Body<"advance-clock">["duration"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["advance-clock"].$post({ json: { environmentId, duration } })
      ),
    (message) => ({ success: false, error: message }) as const
  );
}

export async function resetClock(
  environmentId: Body<"reset-clock">["environmentId"]
) {
  return orFailure(
    () =>
      parseResponse(routes["reset-clock"].$post({ json: { environmentId } })),
    (message) => ({ success: false, error: message }) as const
  );
}

export async function mockProjectTimeLegacy(
  environmentId: Body<"mock-project-time-legacy">["environmentId"],
  mockedAt: Body<"mock-project-time-legacy">["mockedAt"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["mock-project-time-legacy"].$post({
          json: { environmentId, mockedAt },
        })
      ),
    (message) => ({ success: false, mode: "legacy", error: message }) as const
  );
}

export async function advanceClockLegacy(
  environmentId: Body<"advance-clock-legacy">["environmentId"],
  duration: Body<"advance-clock-legacy">["duration"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["advance-clock-legacy"].$post({
          json: { environmentId, duration },
        })
      ),
    (message) => ({ success: false, mode: "legacy", error: message }) as const
  );
}

export async function resetClockLegacy(
  environmentId: Body<"reset-clock-legacy">["environmentId"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["reset-clock-legacy"].$post({ json: { environmentId } })
      ),
    (message) => ({ success: false, mode: "legacy", error: message }) as const
  );
}

export type ClockState = Extract<
  Awaited<ReturnType<typeof getClockState>>,
  { success: true }
>["data"];
