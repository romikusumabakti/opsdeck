"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ActiveRun } from "@/actions/runs";

// The currently-running runs, streamed from /api/runs/running/stream. Two
// consumers need this list — the header indicator and the sidebar History
// badge — and each opening its own EventSource would double the long-lived
// connections per tab (the server holds one poll loop per connection). One
// provider in the shell keeps it at a single stream no matter how many
// consumers appear.
const ActiveRunsContext = createContext<ActiveRun[]>([]);

export function ActiveRunsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [runs, setRuns] = useState<ActiveRun[]>([]);

  // EventSource auto-reconnects on transient errors and after the server's
  // 10-minute max-duration close.
  useEffect(() => {
    const es = new EventSource("/api/runs/running/stream");

    es.addEventListener("snapshot", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as ActiveRun[];
        setRuns(data);
      } catch {
        /* ignore malformed frame */
      }
    });

    return () => {
      es.close();
    };
  }, []);

  return (
    <ActiveRunsContext.Provider value={runs}>
      {children}
    </ActiveRunsContext.Provider>
  );
}

export function useActiveRuns(): ActiveRun[] {
  return useContext(ActiveRunsContext);
}

/** How many runs are in flight for one environment. 0 when none. */
export function useActiveRunCount(environmentId: string | null): number {
  const runs = useActiveRuns();
  if (!environmentId) return 0;
  return runs.filter((run) => run.environmentId === environmentId).length;
}
