"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { setIssueStatus } from "@/actions/issues";
import { type Status, StatusSelect } from "@/components/issues-board";
import { Link } from "@/i18n/navigation";
import type { MyIssue } from "@/lib/home/queries";
import { cn } from "@/lib/utils";

export function MyIssuesList({ items }: { items: MyIssue[] }) {
  const t = useTranslations("homePage");
  const [, startTransition] = React.useTransition();
  const [rows, setOptimistic] = React.useOptimistic(
    items,
    (cur, change: { id: string; status: Status }) =>
      cur.map((i) => (i.id === change.id ? { ...i, status: change.status } : i))
  );

  function changeStatus(id: string, status: Status) {
    startTransition(async () => {
      setOptimistic({ id, status });
      // updateIssue revalidates Home, so resolved/closed rows drop out.
      const res = await setIssueStatus(id, status);
      if (!res.success) toast.error(t("issues.statusFailed"));
    });
  }

  return (
    <ul className="flex flex-col divide-y">
      {rows.map((i) => (
        <li
          key={i.id}
          className={cn(
            "flex items-center gap-3 px-3 py-1.5 transition-opacity",
            (i.status === "resolved" || i.status === "closed") && "opacity-50"
          )}
        >
          <Link
            href={`/${i.projectKey}/issues/${i.number}`}
            title={i.title}
            className="flex min-w-0 flex-1 items-center gap-3 hover:underline"
          >
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {i.projectKey}-{i.number}
            </span>
            <span className="truncate text-sm">{i.title}</span>
          </Link>
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            {i.projectName}
          </span>
          <StatusSelect
            value={i.status as Status}
            onChange={(s) => changeStatus(i.id, s)}
            className="h-7 w-36 shrink-0"
          />
        </li>
      ))}
    </ul>
  );
}
