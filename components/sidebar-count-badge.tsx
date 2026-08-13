"use client";

import { SidebarMenuBadge } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Count badge for one sidebar row.
 *
 * Renders nothing at zero — a permanent "0" teaches people to stop looking at
 * the badge, which defeats the point. Collapsed to icons there is no room for
 * a number, so it degrades to a dot in the icon's corner.
 *
 * Positioned with physical `right`/`left` under an `rtl:` variant rather than
 * logical `end-*`: the base badge already sets `right-1`, and mixing the two
 * lets `right` and `inset-inline-end` race by stylesheet order — the loser
 * resolving to `auto` drops the badge onto its static position, on top of the
 * row's icon.
 */
export function SidebarCountBadge({
  count,
  label,
  variant = "default",
}: {
  count: number;
  /** Screen-reader text, e.g. "3 issues assigned to you". */
  label: string;
  /** `active` marks work in flight (running jobs) rather than a backlog. */
  variant?: "default" | "active";
}) {
  if (count <= 0) return null;

  return (
    <>
      <SidebarMenuBadge
        className={cn(
          "right-1 rtl:right-auto rtl:left-1",
          variant === "active" && "text-primary"
        )}
      >
        <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
        <span className="sr-only">{label}</span>
      </SidebarMenuBadge>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1 right-1 rtl:right-auto rtl:left-1 hidden size-2 rounded-full group-data-[collapsible=icon]:block",
          variant === "active" ? "bg-primary animate-pulse" : "bg-sidebar-ring"
        )}
      />
    </>
  );
}
