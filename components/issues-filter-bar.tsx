"use client";

import { LayoutGrid, List, ListFilter, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

/** Sentinel for "no filter" — a menu radio item can't carry an empty value. */
export const ALL = "all";

export type FilterOption = { id: string; name: string; color?: string };

/**
 * A patch of the URL query: `null` removes the param. The parent turns this
 * into a navigation, which is what re-runs the server query — the toolbar
 * itself holds no filter state beyond the debounced search text.
 */
export type FilterPatch = Record<string, string | null>;

const SEARCH_DEBOUNCE_MS = 300;

const STATUS_VALUES = ["open", "in_progress", "resolved", "closed"] as const;
const PRIORITY_VALUES = ["urgent", "high", "medium", "low"] as const;

/**
 * Toolbar for the issue list.
 *
 * Six facets side by side needed two rows on a laptop and spent that space on
 * controls that were mostly switched off. So the facets collapse into one
 * "Filter" menu, and only the filters that are actually *on* take room, as
 * chips that clear themselves. Chrome scales with what the user is doing
 * instead of with how many filters exist.
 *
 * Renders a fragment, not a wrapper: the controls become direct children of the
 * caller's toolbar row so they share one wrapping flow with whatever the caller
 * appends (the columns menu).
 */
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

  const set = (key: string) => (value: string) =>
    onChange({ [key]: value === ALL ? null : value });

  const nameOf = (options: FilterOption[], id: string) =>
    options.find((o) => o.id === id)?.name ?? id;

  // One chip per active filter, in the order the menu lists them.
  const chips: { key: string; facet: string; value: string }[] = [];
  if (filters.status) {
    chips.push({
      key: "status",
      facet: t("filterStatus"),
      value: t(`status.${filters.status}`),
    });
  }
  if (filters.priority) {
    chips.push({
      key: "priority",
      facet: t("priorityLabel"),
      value: t(`priority.${filters.priority}`),
    });
  }
  if (filters.project) {
    chips.push({
      key: "project",
      facet: t("project"),
      value: nameOf(projects, filters.project),
    });
  }
  if (filters.label) {
    chips.push({
      key: "label",
      facet: t("filterLabel"),
      value: nameOf(labels, filters.label),
    });
  }
  if (filters.mine === "1") {
    chips.push({ key: "mine", facet: t("assignee"), value: t("me") });
  }
  if (isBoard && filters.group) {
    chips.push({
      key: "group",
      facet: t("groupBy"),
      value: t("groupAssignee"),
    });
  }

  return (
    <>
      {leading}
      <div className="relative w-48 shrink">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="h-8 ps-8"
          aria-label={t("searchPlaceholder")}
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant={chips.length > 0 ? "secondary" : "outline"}
              size="sm"
            />
          }
        >
          <ListFilter className="size-4" />
          {t("filter")}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <FacetSubmenu
            label={t("filterStatus")}
            value={filters.status ?? ALL}
            onValueChange={set("status")}
            allLabel={t("allStatuses")}
            options={STATUS_VALUES.map((s) => ({
              id: s,
              name: t(`status.${s}`),
            }))}
          />
          <FacetSubmenu
            label={t("priorityLabel")}
            value={filters.priority ?? ALL}
            onValueChange={set("priority")}
            allLabel={t("allPriorities")}
            options={PRIORITY_VALUES.map((p) => ({
              id: p,
              name: t(`priority.${p}`),
            }))}
          />
          <FacetSubmenu
            label={t("project")}
            value={filters.project ?? ALL}
            onValueChange={set("project")}
            allLabel={t("allProjects")}
            options={projects}
          />
          <FacetSubmenu
            label={t("filterLabel")}
            value={filters.label ?? ALL}
            onValueChange={set("label")}
            allLabel={t("allLabels")}
            options={labels}
          />
          {isBoard && (
            <FacetSubmenu
              label={t("groupBy")}
              value={filters.group ?? ALL}
              onValueChange={set("group")}
              allLabel={t("groupNone")}
              options={[{ id: "assignee", name: t("groupAssignee") }]}
            />
          )}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={filters.mine === "1"}
            onCheckedChange={(checked) =>
              onChange({ mine: checked ? "1" : null })
            }
          >
            {t("assignedToMe")}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {chips.map((chip) => (
        // The whole chip is the clear button: one target, one meaning. The
        // value stays readable, so the bar still says what is being filtered.
        <Button
          key={chip.key}
          variant="secondary"
          size="sm"
          className="gap-1 font-normal"
          aria-label={t("clearFilterAria", { name: chip.facet })}
          onClick={() => onChange({ [chip.key]: null })}
        >
          <span className="text-muted-foreground">{chip.facet}:</span>
          <span className="max-w-40 truncate">{chip.value}</span>
          <X className="size-3.5 opacity-60" />
        </Button>
      ))}

      {/* A radiogroup, not two toggle buttons: the two views are mutually
          exclusive, so screen readers should announce "1 of 2 selected"
          instead of two unrelated pressed states. */}
      <div
        role="radiogroup"
        aria-label={t("viewTable")}
        className="flex h-8 items-center rounded-md border p-0.5"
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
    </>
  );
}

/** One facet as a submenu of single-choice options, with "all" as the reset. */
function FacetSubmenu({
  label,
  value,
  onValueChange,
  allLabel,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  allLabel: string;
  options: FilterOption[];
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      {/* Long facets (a workspace with many projects or labels) scroll inside
          the submenu instead of running off the screen. */}
      <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          <DropdownMenuRadioItem value={ALL}>{allLabel}</DropdownMenuRadioItem>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.id} value={o.id}>
              <span className="flex items-center gap-2">
                {o.color && (
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: o.color }}
                  />
                )}
                {o.name}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
