import {
  type Query,
  QueryClient,
  type QueryExecuteOptions,
  type QueryKey,
} from "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /**
       * The read probes a managed host (SSH or an outbound HTTP call) on every
       * fetch. See `REMOTE_PROBE`.
       */
      remoteProbe?: boolean;
      /**
       * Fixed for the life of the server process (bootstrap): no mutation
       * can change it, so the refetch after a mutation skips it.
       */
      fixed?: boolean;
    };
  }
}

/**
 * Options for a read that probes a managed host — listing backups or
 * databases over SSH, `systemctl status` on every service, a tunnel's ingress.
 * Under Next the backup and database lists sat behind a 30-second
 * `unstable_cache` so navigation didn't keep hitting the host; the same 30
 * seconds is their client staleTime now. They also sit out the refetch that
 * follows every mutation unless the mutation belongs to their own module (see
 * `invalidateAfterMutation`): marking a notification read shouldn't SSH into a
 * database server, and their own module's mutations (creating a database,
 * restarting a service) finish in a background run anyway, which the page
 * follows and refreshes on.
 */
export const REMOTE_PROBE = {
  staleTime: 30_000,
  meta: { remoteProbe: true },
} as const;

/**
 * The SPA's query cache.
 *
 * staleTime 30s: a route loader's `queryClient.query()` and the component's
 * `useSuspenseQuery` read the same entry without a second fetch on mount, and
 * moving between pages reuses what was just loaded. Freshness comes from
 * elsewhere: every successful mutation refetches the active queries (web/api/
 * client.ts), and a focused tab refetches whatever is older than 30s
 * (refetchOnWindowFocus stays on), which picks up other users' changes.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // A 4xx won't change on retry (a 401 has already sent the user to
        // sign-in); give a flaky network or a 5xx one more try.
        retry: (failureCount, error) =>
          failureCount < 1 &&
          !(
            error instanceof Error &&
            "status" in error &&
            typeof error.status === "number" &&
            error.status < 500
          ),
      },
    },
  });
}

export const queryClient = createQueryClient();

/**
 * `/api/me`'s cache key. Here rather than in web/api/session.ts so the API
 * client can clear it on a 401 without importing the module built on it.
 */
export const ME_QUERY_KEY = ["session", "getMe"] as const;

export type RefetchScope = {
  /**
   * The module (`/api/<module>/...`) whose data just changed: its own remote
   * probes refetch along with everything else.
   */
  module?: string;
  /**
   * Refetch every remote probe too — the explicit "reload everything" after
   * a change the query cache never saw (a raw upload, a finished background
   * run, a user's refresh button).
   */
  includeRemote?: boolean;
};

/**
 * Which cached queries a refetch of "whatever may have changed" covers: all
 * of them except the fixed bootstrap and — unless `includeRemote` is set or
 * the probe belongs to `module` — the remote probes. The one rule behind the
 * refetch after a mutation and `router.refresh()` (i18n/navigation.ts).
 */
export function refetchPredicate({
  module,
  includeRemote = false,
}: RefetchScope = {}): (query: Query) => boolean {
  return (query) =>
    query.meta?.fixed !== true &&
    (includeRemote ||
      query.meta?.remoteProbe !== true ||
      (module !== undefined && query.queryKey[0] === module));
}

/**
 * Mark the queries in `scope` stale; the active ones refetch, and the promise
 * resolves once they have.
 */
export function refetchChanged(
  client: QueryClient,
  scope?: RefetchScope
): Promise<void> {
  return client.invalidateQueries({ predicate: refetchPredicate(scope) });
}

/**
 * The refetch that replaces `revalidatePath("/", "layout")`: after a
 * successful mutation under `/api/<module>/...`, every query is marked stale
 * and the active ones refetch — except another module's remote probes and
 * the fixed bootstrap.
 */
export function invalidateAfterMutation(
  client: QueryClient,
  path: string
): Promise<void> {
  return refetchChanged(client, { module: path.split("/")[2] });
}

/**
 * A route loader's read. With nothing cached it fetches, and the navigation
 * waits for it (and fails if it fails). With data cached — of any age — it
 * resolves at once with that data, so a navigation never waits on (or lands on
 * the error page because of) a refetch; a stale entry is refetched in the
 * background, and the component's `useSuspenseQuery` picks the result up. A
 * failed background refetch keeps the cached data on screen.
 */
export function loaderQuery<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(
  client: QueryClient,
  options: QueryExecuteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryFnData,
    TQueryKey
  >
): Promise<TData> {
  if (client.getQueryState(options.queryKey)?.data === undefined) {
    return client.query(options);
  }
  client.query(options).catch(() => {});
  return client.query({ ...options, staleTime: "static" });
}
