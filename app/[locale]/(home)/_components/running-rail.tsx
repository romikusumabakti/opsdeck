"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useActiveRuns } from "@/components/active-runs-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useRouter } from "@/i18n/navigation";
import { formatElapsed } from "@/lib/elapsed";
import { CompactSection, HomeSection } from "./home-section";

export function RunningRail() {
  const t = useTranslations("homePage");
  const runs = useActiveRuns();
  const router = useRouter();
  const [now, setNow] = React.useState(() => Date.now());
  const [openRunId, setOpenRunId] = React.useState<string | null>(null);
  const [openTitle, setOpenTitle] = React.useState("");

  // Tick the elapsed time only while something is running.
  React.useEffect(() => {
    if (runs.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runs.length]);

  // A run that left the list has finished: refresh once so "Needs attention"
  // and "Jump back in" reflect its outcome without a manual reload.
  const previous = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const ids = new Set(runs.map((r) => r.id));
    const finished = [...previous.current].some((id) => !ids.has(id));
    previous.current = ids;
    if (finished) router.refresh();
  }, [runs, router]);

  return (
    <>
      {runs.length === 0 ? (
        <CompactSection
          icon={Loader2}
          title={t("running.title")}
          text={t("running.empty")}
        />
      ) : (
        <HomeSection
          icon={Loader2}
          iconClassName="animate-spin text-primary"
          title={t("running.title")}
          count={runs.length}
        >
          <ul className="flex flex-col divide-y">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpenTitle(run.description);
                    setOpenRunId(run.id);
                  }}
                  className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-accent/50"
                >
                  <span
                    className="w-full truncate text-sm"
                    title={run.description}
                  >
                    {run.description}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {run.environment?.name ?? "—"} ·{" "}
                    <span className="tabular-nums">
                      {formatElapsed(run.runAt, now)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </HomeSection>
      )}
      <LiveRunDialog
        runId={openRunId}
        onOpenChange={(isOpen) => {
          if (!isOpen) setOpenRunId(null);
        }}
        title={openTitle}
      />
    </>
  );
}
