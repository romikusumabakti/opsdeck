"use client";

import { Paperclip } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { MAIL_PAGE_SIZE, type MessagesPage } from "@/lib/mailpit/schemas";
import { cn } from "@/lib/utils";

export function MailList({
  page,
  query,
  start,
  selectedId,
  checked,
  onSelect,
  onCheckedChange,
  onPageChange,
}: {
  page: MessagesPage | null;
  query: string;
  start: number;
  selectedId: string | null;
  checked: Set<string>;
  onSelect: (id: string) => void;
  onCheckedChange: (next: Set<string>) => void;
  onPageChange: (start: number) => void;
}) {
  const t = useTranslations("mail");
  const format = useFormatter();

  if (!page) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <span className="sr-only">{t("loading")}</span>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    );
  }

  const ids = page.messages.map((m) => m.ID);
  const allChecked = ids.length > 0 && ids.every((id) => checked.has(id));

  function toggle(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    onCheckedChange(next);
  }

  function toggleAll(on: boolean) {
    onCheckedChange(
      on
        ? new Set([...checked, ...ids])
        : new Set([...checked].filter((id) => !ids.includes(id)))
    );
  }

  return (
    <div className="flex min-h-0 flex-col rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <Checkbox
          checked={allChecked}
          onCheckedChange={(on) => toggleAll(on)}
          disabled={ids.length === 0}
          aria-label={t("selectAll")}
        />
        <span>{t("total", { count: page.messages_count })}</span>
      </div>

      {page.messages.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {query ? t("emptySearch") : t("empty")}
        </p>
      ) : (
        <ul className="flex-1 divide-y overflow-y-auto">
          {page.messages.map((m) => (
            <li
              key={m.ID}
              className={cn(
                "flex gap-2 px-3 py-2",
                m.ID === selectedId && "bg-muted"
              )}
            >
              <Checkbox
                className="mt-1"
                checked={checked.has(m.ID)}
                onCheckedChange={(on) => toggle(m.ID, on)}
                aria-label={m.Subject || t("noSubject")}
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-start"
                onClick={() => onSelect(m.ID)}
              >
                <div className="flex items-center gap-2">
                  {!m.Read && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-primary"
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn(
                      "truncate text-sm",
                      !m.Read && "font-semibold"
                    )}
                  >
                    {m.From?.Name || m.From?.Address || "—"}
                  </span>
                  <time
                    className="ms-auto shrink-0 text-xs text-muted-foreground"
                    dateTime={m.Created}
                  >
                    {format.relativeTime(new Date(m.Created))}
                  </time>
                </div>
                <div className="flex items-center gap-1">
                  <span className="truncate text-sm">
                    {m.Subject || t("noSubject")}
                  </span>
                  {m.Attachments > 0 && (
                    <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {m.Snippet}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between border-t px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={start === 0}
          onClick={() => onPageChange(Math.max(0, start - MAIL_PAGE_SIZE))}
        >
          {t("previous")}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {page.messages.length === 0 ? 0 : start + 1}–
          {start + page.messages.length}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={start + MAIL_PAGE_SIZE >= page.messages_count}
          onClick={() => onPageChange(start + MAIL_PAGE_SIZE)}
        >
          {t("next")}
        </Button>
      </div>
    </div>
  );
}
