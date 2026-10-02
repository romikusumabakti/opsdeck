"use client";

import { Download, Paperclip, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useEffectEvent, useState, useTransition } from "react";
import {
  getMail,
  getMailSource,
  type MailDetail,
  type MailResult,
} from "@/actions/mail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MailAddress } from "@/lib/mailpit/schemas";
import { formatBytes } from "@/lib/utils";

function formatAddresses(list: MailAddress[]): string {
  return list
    .map((a) => (a.Name ? `${a.Name} <${a.Address}>` : a.Address))
    .join(", ");
}

function Pane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded-lg border">
      {children}
    </div>
  );
}

export function MailDetailPane({
  environmentId,
  messageId,
  onDelete,
  onGone,
}: {
  environmentId: string;
  messageId: string | null;
  onDelete: (id: string) => void;
  onGone: () => void;
}) {
  const t = useTranslations("mail");
  const format = useFormatter();
  const [detail, setDetail] = useState<{
    id: string;
    result: MailResult<MailDetail>;
  } | null>(null);
  const [source, setSource] = useState<{
    id: string;
    result: MailResult<{ source: string; truncated: boolean }>;
  } | null>(null);
  const [loading, startLoading] = useTransition();
  const notifyGone = useEffectEvent(onGone);

  useEffect(() => {
    if (!messageId) return;
    startLoading(async () => {
      const result = await getMail(environmentId, messageId);
      setDetail({ id: messageId, result });
      // Opening marks it read upstream; a 404 means it was deleted elsewhere.
      if (!result.success && result.notFound) notifyGone();
    });
  }, [environmentId, messageId]);

  function loadSource(id: string) {
    if (source?.id === id) return;
    startLoading(async () => {
      setSource({ id, result: await getMailSource(environmentId, id) });
    });
  }

  if (!messageId) {
    return (
      <Pane>
        <p className="m-auto p-6 text-sm text-muted-foreground">
          {t("selectPrompt")}
        </p>
      </Pane>
    );
  }

  if (!detail || detail.id !== messageId) {
    return (
      <Pane>
        <div className="flex flex-col gap-2 p-4">
          <span className="sr-only">{t("loading")}</span>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-[50vh] w-full" />
        </div>
      </Pane>
    );
  }

  if (!detail.result.success) {
    return (
      <Pane>
        <p className="m-auto p-6 text-sm text-muted-foreground">
          {detail.result.notFound ? t("messageGone") : detail.result.error}
        </p>
      </Pane>
    );
  }

  const { message, html, headers } = detail.result.data;
  const base = `/api/environments/${environmentId}/mail/${message.ID}`;
  const files = [...message.Attachments];

  return (
    <Pane>
      <div className="flex items-start gap-2 border-b p-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="break-words text-base font-semibold">
            {message.Subject || t("noSubject")}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">{t("from")}</dt>
            <dd className="break-all">
              {formatAddresses(message.From ? [message.From] : [])}
            </dd>
            <dt className="text-muted-foreground">{t("to")}</dt>
            <dd className="break-all">{formatAddresses(message.To)}</dd>
            {message.Cc.length > 0 && (
              <>
                <dt className="text-muted-foreground">{t("cc")}</dt>
                <dd className="break-all">{formatAddresses(message.Cc)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t("date")}</dt>
            <dd>
              {format.dateTime(new Date(message.Date), {
                dateStyle: "medium",
                timeStyle: "medium",
              })}
            </dd>
          </dl>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<a href={`${base}/raw`} download />}
        >
          <Download className="size-4" />
          {t("downloadEml")}
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onDelete(message.ID)}
          aria-label={t("delete")}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
          <span className="text-muted-foreground">{t("attachments")}</span>
          {files.map((file) => (
            <a
              key={file.PartID}
              href={`${base}/part/${encodeURIComponent(file.PartID)}`}
              download
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
            >
              <Paperclip className="size-3" />
              <span className="max-w-48 truncate">
                {file.FileName || file.PartID}
              </span>
              <span className="text-muted-foreground">
                {formatBytes(file.Size)}
              </span>
            </a>
          ))}
        </div>
      )}

      <Tabs
        key={message.ID}
        defaultValue={html ? "html" : "text"}
        className="min-h-0 flex-1 p-4"
        onValueChange={(value) => {
          if (value === "raw") loadSource(message.ID);
        }}
      >
        <TabsList>
          <TabsTrigger value="html">{t("tabHtml")}</TabsTrigger>
          <TabsTrigger value="text">{t("tabText")}</TabsTrigger>
          <TabsTrigger value="headers">{t("tabHeaders")}</TabsTrigger>
          <TabsTrigger value="raw">{t("tabRaw")}</TabsTrigger>
        </TabsList>

        <TabsContent value="html">
          {html ? (
            // srcdoc, not src: the app sends frame-ancestors 'none'. No
            // allow-scripts / allow-same-origin — the email can't run code or
            // touch OpsDeck; popups let QA follow reset/verify links.
            <iframe
              title={message.Subject || t("noSubject")}
              srcDoc={html}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              className="h-[60vh] w-full rounded-md border bg-white"
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("noHtml")}</p>
          )}
        </TabsContent>

        <TabsContent value="text">
          {message.Text ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm">
              {message.Text}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noText")}</p>
          )}
        </TabsContent>

        <TabsContent value="headers">
          <dl className="max-h-[60vh] overflow-auto text-xs">
            {Object.entries(headers).flatMap(([name, values]) =>
              values.map((value, i) => (
                <div
                  key={`${name}-${i}`}
                  className="grid grid-cols-[minmax(8rem,12rem)_1fr] gap-2 border-b py-1 font-mono"
                >
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))
            )}
          </dl>
        </TabsContent>

        <TabsContent value="raw">
          {source?.id !== message.ID || loading ? (
            <Skeleton className="h-[50vh] w-full" />
          ) : source.result.success ? (
            <>
              {source.result.data.truncated && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {t("sourceTruncated")}
                </p>
              )}
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                {source.result.data.source}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {source.result.error}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </Pane>
  );
}
