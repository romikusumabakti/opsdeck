"use client";

import { Check, Tag } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Label, LabelLite } from "@/lib/db/schema";

// A colored label pill. Color is a hex string; we tint the background and
// border from it (Tailwind can't express dynamic colors, so inline style).
export function LabelChip({ label }: { label: LabelLite }) {
  return (
    <span
      className="inline-flex max-w-28 shrink-0 items-center overflow-hidden rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap"
      title={label.name}
      style={{
        color: label.color,
        borderColor: `${label.color}66`,
        backgroundColor: `${label.color}1a`,
      }}
    >
      <span className="truncate">{label.name}</span>
    </span>
  );
}

// `max` caps how many chips render; the rest collapse into a `+N` chip that
// lists them on hover. Dense rows (table cells) pass a small max so a heavily
// labelled issue can't wrap the row into three lines.
export function LabelChips({
  labels,
  className,
  max,
}: {
  labels: LabelLite[];
  className?: string;
  max?: number;
}) {
  if (labels.length === 0) return null;
  const shown = max === undefined ? labels : labels.slice(0, max);
  const rest = labels.slice(shown.length);
  return (
    <span className={className ?? "inline-flex flex-wrap items-center gap-1"}>
      {shown.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
      {rest.length > 0 ? (
        <span
          className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
          title={rest.map((l) => l.name).join(", ")}
        >
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}

// Multi-select label picker. Toggling a row calls `onChange` with the new id
// set; the caller persists it.
export function LabelPicker({
  allLabels,
  selected,
  onChange,
}: {
  allLabels: Label[];
  selected: string[];
  onChange: (labelIds: string[]) => void;
}) {
  const t = useTranslations("issueDetail");
  const selectedSet = new Set(selected);

  function toggle(id: string) {
    const next = new Set(selectedSet);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange([...next]);
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="h-8 justify-start" />
        }
      >
        <Tag className="size-3.5" />
        {t("labels")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <ul className="flex flex-col">
          {allLabels.map((l) => {
            const on = selectedSet.has(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => toggle(l.id)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors"
                >
                  <span
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: l.color }}
                  />
                  <span className="flex-1 text-start">{l.name}</span>
                  {on ? <Check className="size-4 shrink-0" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
