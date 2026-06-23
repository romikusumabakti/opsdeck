"use client";

import * as React from "react";
import {
  type LevelFilter,
  LogViewer,
  type LogViewerState,
} from "@/components/log-viewer";
import { usePathname, useRouter } from "@/i18n/navigation";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import type { LogLines, ServiceRole } from "@/lib/services";

export type InitialLogState = {
  tail: LogLines;
  q: string;
  level: LevelFilter;
  view: "pretty" | "raw";
};

type Props = {
  project: SafeProjectWithServers;
  role: ServiceRole;
  serviceName: string;
  initial: InitialLogState;
};

// Full-page log viewer. Mirrors the viewer's serializable state into the URL
// (replace, not push — scrubbing a filter shouldn't pile up history entries)
// so a filtered view is shareable, bookmarkable, and survives a reload. Only
// non-default values are written to keep the query string clean.
export function LogsClient({ project, role, serviceName, initial }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const onStateChange = React.useCallback(
    (state: LogViewerState) => {
      const params = new URLSearchParams();
      if (state.tail !== 200) params.set("tail", String(state.tail));
      if (state.q) params.set("q", state.q);
      if (state.level !== "all") params.set("level", state.level);
      if (state.view !== "pretty") params.set("view", state.view);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname]
  );

  return (
    <LogViewer
      project={project}
      role={role}
      serviceName={serviceName}
      initial={initial}
      onStateChange={onStateChange}
      showLevelFilter
      className="flex-1"
    />
  );
}
