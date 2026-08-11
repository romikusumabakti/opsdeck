"use client";

import { LayoutGrid, List, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel for "no filter" — a Select item can't carry an empty value. */
export const ALL = "all";

export type FilterOption = { id: string; name: string; color?: string };

/**
 * A patch of the URL query: `null` removes the param. The parent turns this
 * into a navigation, which is what re-runs the server query — the toolbar
 * itself holds no filter state beyond the debounced search text.
 */
export type FilterPatch = Record<string, string | null>;

const SEARCH_DEBOUNCE_MS = 300;

export function IssuesFilterBar({
  filters,
  onChange,
  projects,
  labels,
  leading,
}: {
  filters: Record<string, string>;
  onChange: (patch: FilterPatch) => void;
  projects: FilterOption[];
  labels: FilterOption[];
  /** Rendered at the start of the bar — the saved-views control. */
  leading?: React.ReactNode;
}) {
  const t = useTranslations("issues");
  const isBoard = filters.view === "board";

  // The only piece of local state here: the search box must stay responsive per
  // keystroke, while the (server) query runs at most once per pause.
  const [query, setQuery] = React.useState(filters.q ?? "");
  const urlQuery = filters.q ?? "";
  // Re-sync when the URL changes from outside the box (a saved view, the back
  // button) — otherwise the input would keep showing the previous search.
  React.useEffect(() => setQuery(urlQuery), [urlQuery]);
  React.useEffect(() => {
    if (query === urlQuery) return;
    const id = setTimeout(
      () => onChange({ q: query.trim() || null }),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(id);
  }, [query, urlQuery, onChange]);

  const select = (key: string) => (value: string | null) =>
    onChange({ [key]: !value || value === ALL ? null : value });

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2">
      {leading}
      <div className="relative min-w-52 flex-1">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="ps-9"
          aria-label={t("searchPlaceholder")}
        />
      </div>

      <Select value={filters.status ?? ALL} onValueChange={select("status")}>
        <SelectTrigger className="w-40" aria-label={t("filterStatus")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
          {(["open", "in_progress", "resolved", "closed"] as const).map((s) => (
            <SelectItem key={s} value={s}>
              {t(`status.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.priority ?? ALL}
        onValueChange={select("priority")}
      >
        <SelectTrigger className="w-36" aria-label={t("priorityLabel")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("allPriorities")}</SelectItem>
          {(["urgent", "high", "medium", "low"] as const).map((p) => (
            <SelectItem key={p} value={p}>
              {t(`priority.${p}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.project ?? ALL} onValueChange={select("project")}>
        <SelectTrigger className="w-44" aria-label={t("project")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("allProjects")}</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.label ?? ALL} onValueChange={select("label")}>
        <SelectTrigger className="w-40" aria-label={t("filterLabel")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("allLabels")}</SelectItem>
          {labels.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              <span className="flex items-center gap-2">
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                {l.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant={filters.mine === "1" ? "secondary" : "outline"}
        aria-pressed={filters.mine === "1"}
        onClick={() => onChange({ mine: filters.mine === "1" ? null : "1" })}
      >
        {t("assignedToMe")}
      </Button>

      {isBoard && (
        <Select
          value={filters.group ?? "none"}
          // "none" is the default, so it stays out of the URL entirely.
          onValueChange={(v) => onChange({ group: v === "none" ? null : v })}
        >
          <SelectTrigger className="w-40" aria-label={t("groupBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("groupNone")}</SelectItem>
            <SelectItem value="assignee">{t("groupAssignee")}</SelectItem>
          </SelectContent>
        </Select>
      )}

      {/* A radiogroup, not two toggle buttons: the two views are mutually
          exclusive, so screen readers should announce "1 of 2 selected"
          instead of two unrelated pressed states. */}
      <div
        role="radiogroup"
        aria-label={t("viewTable")}
        className="flex rounded-md border p-0.5"
      >
        <Button
          type="button"
          role="radio"
          aria-checked={!isBoard}
          variant={isBoard ? "ghost" : "secondary"}
          size="sm"
          className="h-7 px-2"
          onClick={() => onChange({ view: null })}
          aria-label={t("viewTable")}
        >
          <List className="size-4" />
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={isBoard}
          variant={isBoard ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2"
          onClick={() => onChange({ view: "board" })}
          aria-label={t("viewBoard")}
        >
          <LayoutGrid className="size-4" />
        </Button>
      </div>
    </div>
  );
}
