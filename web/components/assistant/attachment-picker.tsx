import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes } from "@/lib/utils";
import { listIssueAttachmentsQuery } from "@/web/api/assistant";
import { useAssistantErrorText } from "./error-text";

export type PickedAttachment = {
  id: string;
  filename: string;
  issueKey: string;
};

/**
 * Pick Jira attachments for the next question: enter an issue key, tick
 * attachments (at most `max` per message, counting the ones already
 * `picked`, which show ticked and locked), confirm after the participant-data
 * warning.
 * Nothing is read until the question is sent with the ticked ids.
 */
export function AttachmentPicker({
  environmentId,
  open,
  onOpenChange,
  max,
  picked,
  onAdd,
}: {
  environmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Attachments per message. */
  max: number;
  /** Ids already chosen for this message. */
  picked: ReadonlySet<string>;
  onAdd: (attachments: PickedAttachment[]) => void;
}) {
  const t = useTranslations("assistant");
  const tCommon = useTranslations("common");
  const { errorText } = useAssistantErrorText();
  const [keyInput, setKeyInput] = React.useState("");
  const [issueKey, setIssueKey] = React.useState<string | null>(null);
  const [ticked, setTicked] = React.useState<Set<string>>(new Set());

  const list = useQuery({
    ...listIssueAttachmentsQuery(environmentId, issueKey ?? ""),
    enabled: open && issueKey !== null,
    retry: false,
  });

  const show = (event: React.FormEvent) => {
    event.preventDefault();
    const key = keyInput.trim().toUpperCase();
    if (!key) return;
    setIssueKey(key);
    setTicked(new Set());
  };

  const toggle = (id: string, checked: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const confirm = () => {
    const data = list.data;
    if (!data) return;
    onAdd(
      data.attachments
        .filter((a) => ticked.has(a.id) && !picked.has(a.id))
        .map((a) => ({ id: a.id, filename: a.filename, issueKey: data.key }))
    );
    setTicked(new Set());
    onOpenChange(false);
  };

  const attachments = list.data?.attachments ?? [];
  const full = picked.size + ticked.size >= max;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("pickerTitle")}</DialogTitle>
          <DialogDescription>
            {t("pickerDescription", { max })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={show} className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="assistant-issue-key">{t("issueKey")}</Label>
            <Input
              id="assistant-issue-key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={t("issueKeyPlaceholder")}
              maxLength={64}
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="outline" disabled={!keyInput.trim()}>
            {t("showAttachments")}
          </Button>
        </form>

        {list.isFetching && (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        )}
        {list.isError && (
          <p className="text-sm text-destructive">{errorText(list.error)}</p>
        )}
        {list.data?.unavailable && (
          <p className="text-sm text-muted-foreground">
            {t("attachmentsUnavailable")}
          </p>
        )}
        {list.data && !list.data.unavailable && attachments.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("noAttachments")}</p>
        )}
        {attachments.length > 0 && (
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
            {attachments.map((a) => {
              const already = picked.has(a.id);
              const checked = already || ticked.has(a.id);
              const id = `assistant-attachment-${a.id}`;
              return (
                <li key={a.id} className="flex items-start gap-2">
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={already || (!checked && full)}
                    onCheckedChange={(value) => toggle(a.id, value)}
                  />
                  <Label
                    htmlFor={id}
                    className="flex min-w-0 flex-col items-start gap-0.5 font-normal"
                  >
                    <span className="break-all">{a.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.mime} · {formatBytes(a.sizeBytes)}
                    </span>
                  </Label>
                </li>
              );
            })}
          </ul>
        )}
        {full && attachments.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("attachmentLimit", { max })}
          </p>
        )}

        <Alert>
          <TriangleAlert />
          <AlertDescription>{t("attachmentWarning")}</AlertDescription>
        </Alert>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={confirm} disabled={ticked.size === 0}>
            {t("useAttachments", { count: ticked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
