import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.profile;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function updateProfile(input: Body<"update-profile">["input"]) {
  return orFailure(
    () => parseResponse(routes["update-profile"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function setStatus(input: Body<"set-status">["input"]) {
  return orFailure(
    () => parseResponse(routes["set-status"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function clearStatus() {
  return orFailure(
    () => parseResponse(routes["clear-status"].$post()),
    (message) => ({ success: false, message }) as const
  );
}

export async function adminUpdateProfile(
  input: Body<"admin-update-profile">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["admin-update-profile"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function adminRemoveAvatar(
  input: Body<"admin-remove-avatar">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["admin-remove-avatar"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function setMyTimeZone(
  timezone: Body<"set-my-time-zone">["timezone"]
) {
  return orFailure(
    () =>
      parseResponse(routes["set-my-time-zone"].$post({ json: { timezone } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function setAccentColor(input: Body<"set-accent-color">["input"]) {
  return orFailure(
    () => parseResponse(routes["set-accent-color"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function setMotif(input: Body<"set-motif">["input"]) {
  return orFailure(
    () => parseResponse(routes["set-motif"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

/** Page data for the account page: `{ hasMicrosoftAccount }`. */
export async function getAccount() {
  return parseResponse(routes.account.$get());
}

export const getAccountQuery = (...args: Parameters<typeof getAccount>) =>
  queryOptions({
    queryKey: ["profile", "getAccount", args],
    queryFn: () => getAccount(...args),
  });
