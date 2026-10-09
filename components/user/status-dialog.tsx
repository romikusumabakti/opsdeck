"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { clearStatus, setStatus } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import { expiryFromPreset, type StatusPreset } from "@/lib/user-display";
import { PROFILE_LIMITS } from "@/lib/validation";

const SUGGESTIONS = [
  { emoji: "🎯", key: "focus", preset: "1h" },
  { emoji: "🗓️", key: "meeting", preset: "1h" },
  { emoji: "🤒", key: "sick", preset: "today" },
  { emoji: "🌴", key: "leave", preset: "week" },
  { emoji: "🏠", key: "wfh", preset: "today" },
] as const;
const QUICK_EMOJI = ["🎯", "🗓️", "🤒", "🌴", "🏠", "🚗", "🍽️", "🔧", "🚀", "☕"];
const PRESETS: StatusPreset[] = ["30m", "1h", "4h", "today", "week", "never"];

/** Controlled dialog for setting the caller's status. Opened from the user menu. */
export function StatusDialog({
  open,
  onOpenChange,
  current,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: { emoji: string | null; text: string | null } | null;
  timeZone: string;
}) {
  const t = useTranslations("status");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [emoji, setEmoji] = useState(current?.emoji ?? "💬");
  const [text, setText] = useState(current?.text ?? "");
  const [preset, setPreset] = useState<StatusPreset>("today");

  const run = (fn: () => Promise<{ success: boolean; message?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.success) return void toast.error(res.message);
      onOpenChange(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              aria-label={t("emoji")}
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              className="w-14 text-center text-lg"
            />
            <Input
              aria-label={t("text")}
              placeholder={t("placeholder")}
              value={text}
              maxLength={PROFILE_LIMITS.statusText}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {QUICK_EMOJI.map((e) => (
              <Button
                key={e}
                type="button"
                size="icon"
                variant="ghost"
                aria-label={e}
                onClick={() => setEmoji(e)}
              >
                {e}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {SUGGESTIONS.map((s) => (
              <Button
                key={s.key}
                type="button"
                variant="ghost"
                className="justify-start"
                onClick={() => {
                  setEmoji(s.emoji);
                  setText(t(`suggestions.${s.key}`));
                  setPreset(s.preset);
                }}
              >
                {s.emoji} {t(`suggestions.${s.key}`)}
                <span className="ms-auto text-xs text-muted-foreground">
                  {t(`presets.${s.preset}`)}
                </span>
              </Button>
            ))}
          </div>
          <Select
            value={preset}
            onValueChange={(v) => {
              if (v) setPreset(v as StatusPreset);
            }}
          >
            <SelectTrigger aria-label={t("clearAfter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`presets.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          {current && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => run(clearStatus)}
            >
              {t("clear")}
            </Button>
          )}
          <Button
            disabled={pending}
            onClick={() =>
              run(() =>
                setStatus({
                  emoji: emoji.trim() || null,
                  text,
                  expiresAt:
                    expiryFromPreset(
                      preset,
                      new Date(),
                      timeZone
                    )?.toISOString() ?? null,
                })
              )
            }
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
