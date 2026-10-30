import { type Query, QueryClient } from "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /**
       * The read probes a managed host (SSH or an outbound HTTP call) on every
       * fetch. See `REMOTE_PROBE`.
       */
      remoteProbe?: boolean;
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
 * staleTime 30s: a route loader's `ensureQueryData` and the component's
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
 * The refetch that replaces `revalidatePath("/", "layout")`: after a
 * successful mutation under `/api/<module>/...`, every query is marked stale
 * and the active ones refetch — except another module's remote probes.
 */
export function invalidateAfterMutation(
  client: QueryClient,
  path: string
): Promise<void> {
  const module = path.split("/")[2];
  return client.invalidateQueries({
    predicate: (query: Query) =>
      query.meta?.remoteProbe !== true || query.queryKey[0] === module,
  });
}
