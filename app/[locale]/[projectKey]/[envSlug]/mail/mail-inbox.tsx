"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { deleteMail, listMail } from "@/actions/mail";
import { useDialog } from "@/components/dialog-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MessagesPage } from "@/lib/mailpit/schemas";
import { cn } from "@/lib/utils";
import type { MailDeleteTarget } from "@/lib/validation";
import { MailDetailPane } from "./mail-detail";
import { MailList } from "./mail-list";

// Debounce realtime bursts (a test suite sending 20 mails) into one refetch.
const REFRESH_DEBOUNCE_MS = 500;

export function MailInbox({ environmentId }: { environmentId: string }) {
  const t = useTranslations("mail");
  const tCommon = useTranslations("common");
  const dialog = useDialog();

  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(0);
  const [page, setPage] = useState<MessagesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [live, setLive] = useState(false);
  const [loading, startLoading] = useTransition();
  const [deleting, startDeleting] = useTransition();

  const load = useCallback(() => {
    startLoading(async () => {
      const result = await listMail(environmentId, { query, start });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setError(null);
      setPage(result.data);
      // Drop selections that scrolled off or were deleted elsewhere.
      const ids = new Set(result.data.messages.map((m) => m.ID));
      setChecked((prev) => new Set([...prev].filter((id) => ids.has(id))));
    });
  }, [environmentId, query, start]);

  useEffect(() => {
    load();
  }, [load]);

  const onMailEvent = useEffectEvent(() => load());

  useEffect(() => {
    const source = new EventSource(
      `/api/environments/${environmentId}/mail/events`
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("ready", () => setLive(true));
    source.addEventListener("mail", () => {
      clearTimeout(timer);
      timer = setTimeout(onMailEvent, REFRESH_DEBOUNCE_MS);
    });
    source.onerror = () => setLive(false);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [environmentId]);

  async function confirmDelete(target: MailDeleteTarget, description: string) {
    const ok = await dialog.confirm({
      title: t("deleteConfirmTitle"),
      description,
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    startDeleting(async () => {
      const result = await deleteMail(environmentId, target);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(t("deleted"));
      if (
        target.scope !== "ids" ||
        (selectedId !== null && target.ids.includes(selectedId))
      ) {
        setSelectedId(null);
      }
      setChecked(new Set());
      load();
    });
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setStart(0);
    setSelectedId(null);
    setQuery(queryInput.trim());
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <form className="min-w-64 flex-1" onSubmit={onSearch}>
          <Input
            type="search"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
          />
        </form>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            live
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              live ? "bg-emerald-500" : "bg-muted-foreground/50"
            )}
            aria-hidden
          />
          {live ? t("live") : t("offline")}
        </span>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          {t("refresh")}
        </Button>
        {checked.size > 0 && (
          <Button
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() =>
              confirmDelete(
                { scope: "ids", ids: [...checked] },
                t("deleteSelectedConfirm", { count: checked.size })
              )
            }
          >
            <Trash2 className="size-4" />
            {t("deleteSelected", { count: checked.size })}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={deleting || !page?.messages_count}
          onClick={() =>
            query
              ? confirmDelete(
                  { scope: "search", query },
                  t("deleteMatchingConfirm", { query })
                )
              : confirmDelete({ scope: "all" }, t("deleteAllConfirm"))
          }
        >
          <Trash2 className="size-4" />
          {query ? t("deleteMatching") : t("deleteAll")}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("loadFailed")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span className="break-all">{error}</span>
            <Button size="sm" variant="outline" onClick={load}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-[60vh] gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <MailList
          page={page}
          query={query}
          start={start}
          selectedId={selectedId}
          checked={checked}
          onSelect={setSelectedId}
          onCheckedChange={setChecked}
          onPageChange={setStart}
        />
        <MailDetailPane
          environmentId={environmentId}
          messageId={selectedId}
          onDelete={(id) =>
            confirmDelete(
              { scope: "ids", ids: [id] },
              t("deleteSelectedConfirm", { count: 1 })
            )
          }
          onGone={load}
        />
      </div>
    </div>
  );
}
