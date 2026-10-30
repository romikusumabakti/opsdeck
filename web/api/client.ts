import type { QueryClient } from "@tanstack/react-query";
import { hc, type InferRequestType } from "hono/client";
import { hasLocale } from "use-intl";
import { defaultLocale, locales } from "@/i18n/locales";
import type { AppType } from "@/server/app";
import {
  invalidateAfterMutation,
  ME_QUERY_KEY,
  queryClient,
} from "@/web/query-client";

// The SPA's transport: the typed Hono client (`api`) over a fetch wrapper that
// does what the Next runtime used to do around a server action.
//
//  - States the route's locale in `X-Locale`, since the API never sees the
//    `/<locale>/` URL (server/middleware/locale.ts).
//  - A 401 means the session is gone: forget the cached `/api/me` and go to
//    sign-in, remembering the page.
//  - A successful mutation refetches the active queries, as
//    `revalidatePath("/", "layout")` re-rendered the page after an action. The
//    call resolves once that refetch is done, so — like an action — the UI
//    already shows the new data when the caller's `await` returns.
//  - Any other non-2xx response rejects with `ApiError { status, message }`.
//
// ERROR CONTRACT of the web/api/<module>.ts wrappers. The wrappers keep the
// old action names, parameters and return types, so components call them as
// they called the actions. What a failure looks like follows the return type:
//
//  1. The action returned a result union — a `success` or `ok` field with a
//     failure branch (`ActionResponse`, `{ success: false; error }`, the
//     mock-time and Mailpit results, `{ ok: false; message }`): the wrapper
//     never rejects with an ApiError. A 4xx/5xx becomes that type's failure
//     branch, the ApiError's message in whichever field the type uses
//     (`message` or `error`), so the component's existing `if (!res.success)`
//     toast fires. The router's `400 {"error":"Invalid request"}` and the
//     generic 500 end up there.
//  2. Everything else — plain data, `void`, `{ runId }`: the wrapper rejects
//     with the ApiError. Callers that used try/catch around the action (or a
//     query's error boundary) handle it as before.
//
// A 401 rejects in both cases, after the navigation to sign-in has started:
// the page is going away and must not render a failure state first.

/** A non-2xx API response: its status and the body's `error` message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Pages a signed-out visitor may be on; a 401 there is the page's own error.
const PUBLIC_FIRST_SEGMENTS = new Set([
  "sign-in",
  "accept-invite",
  "setup",
  "forgot-password",
  "reset-password",
]);

const READ_METHODS = new Set(["GET", "HEAD"]);

export type ApiFetchDeps = {
  queryClient: QueryClient;
  /** Client-side navigation to an absolute in-app href. */
  navigate: (href: string) => void;
  /** The current URL's path and query (`?a=b` or ""). */
  location: () => { pathname: string; search: string };
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error
    ) {
      return body.error;
    }
  } catch {
    // Not JSON (a proxy's error page): fall through to the status text.
  }
  return response.statusText || `HTTP ${response.status}`;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

function requestPath(input: RequestInfo | URL): string {
  const url =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  return new URL(url, "http://localhost").pathname;
}

/** The fetch wrapper behind `api`; exported with its dependencies for tests. */
export function createApiFetch(deps: ApiFetchDeps): typeof fetch {
  const apiFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname, search } = deps.location();
    const [, first = "", ...rest] = pathname.split("/");
    const onLocaleRoute = hasLocale(locales, first);
    const locale = onLocaleRoute ? first : defaultLocale;

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set("X-Locale", locale);
    const response = await deps.fetch(input, { ...init, headers });

    if (response.ok) {
      if (!READ_METHODS.has(requestMethod(input, init))) {
        await invalidateAfterMutation(deps.queryClient, requestPath(input));
      }
      return response;
    }

    if (response.status === 401) {
      // The session is gone: forget the cached user first, so the $locale
      // gate sees a signed-out visitor on this navigation and every later
      // one, and the shell stops showing the previous identity.
      deps.queryClient.setQueryData(ME_QUERY_KEY, null);
      const stripped = onLocaleRoute ? rest : [first, ...rest];
      if (!PUBLIC_FIRST_SEGMENTS.has(stripped[0] ?? "")) {
        const path = `/${stripped.join("/")}`.replace(/\/+$/, "") || "/";
        const redirect = encodeURIComponent(path + search);
        deps.navigate(`/${locale}/sign-in?redirect=${redirect}`);
      }
    }
    throw new ApiError(response.status, await errorMessage(response));
  };
  return apiFetch as typeof fetch;
}

// Set by web/router.tsx once the router exists; a full page load until then.
let navigateTo: (href: string) => void = (href) => {
  window.location.assign(href);
};

export function setApiNavigator(navigate: (href: string) => void): void {
  navigateTo = navigate;
}

export const apiFetch = createApiFetch({
  queryClient,
  navigate: (href) => navigateTo(href),
  location: () => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }),
  fetch: (input, init) => fetch(input, init),
});

export const api = hc<AppType>("/", { fetch: apiFetch });

/**
 * Rule 1 of the error contract: turn an ApiError (other than a 401) into the
 * action's own failure result.
 */
export async function orFailure<T>(
  call: () => Promise<T>,
  failure: (message: string) => NoInfer<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) {
      return failure(error.message);
    }
    throw error;
  }
}

/**
 * The JSON body a router's POST endpoint `K` takes; the wrappers type their
 * parameters with it, so they follow the router's validators.
 */
export type PostJson<R, K extends keyof R> = R[K] extends { $post: infer F }
  ? InferRequestType<F> extends { json: infer J }
    ? J
    : never
  : never;
