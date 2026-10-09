"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateProfile } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AvatarCropper } from "@/components/user/avatar-cropper";
import { TimezoneSelect } from "@/components/user/timezone-select";
import { UserAvatar } from "@/components/user/user-avatar";
import { Link, useRouter } from "@/i18n/navigation";
import type { WorkingHours } from "@/lib/user-display";
import { PROFILE_LIMITS } from "@/lib/validation";

type ProfileUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  title: string | null;
  bio: string | null;
  timezone: string | null;
  workingHours: WorkingHours | null;
};

const DEFAULT_HOURS: WorkingHours = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
};

export function ProfileForm({
  user,
  appTimeZone,
  hasMicrosoft,
}: {
  user: ProfileUser;
  appTimeZone: string;
  hasMicrosoft: boolean;
}) {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(user.name);
  const [title, setTitle] = useState(user.title ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [timezone, setTimezone] = useState(user.timezone);
  const [hours, setHours] = useState<WorkingHours | null>(user.workingHours);
  const [cropping, setCropping] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Weekday labels in the app locale, Monday first (ISO 1..7). Fixed UTC zone
  // so the server and client renders agree.
  const weekdayFmt = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const weekdays = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    d,
    label: weekdayFmt.format(new Date(Date.UTC(2024, 0, d))), // 2024-01-01 is a Monday
  }));

  /**
   * Sends an avatar request; toasts the mapped error and returns null on
   * failure. Never throws: a rejection inside startTransition would replace
   * the page with the error boundary.
   */
  async function sendAvatar(
    url: string,
    init: RequestInit
  ): Promise<Response | null> {
    const res = await fetch(url, init).catch(() => null);
    if (!res) {
      toast.error(t("avatarError.storage"));
      return null;
    }
    if (res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    toast.error(t(`avatarError.${body.error ?? "storage"}`));
    return null;
  }

  async function uploadAvatar(blob: Blob) {
    const body = new FormData();
    body.set("file", blob, "avatar");
    if (await sendAvatar("/api/avatars", { method: "POST", body }))
      router.refresh();
  }

  async function removeAvatar() {
    if (await sendAvatar("/api/avatars", { method: "DELETE" }))
      router.refresh();
  }

  async function importMicrosoftAvatar() {
    const res = await sendAvatar("/api/avatars/microsoft", { method: "POST" });
    if (!res) return;
    const { result } = (await res.json().catch(() => ({}))) as {
      result?: string;
    };
    if (result === "no_photo") toast.info(t("avatarNoMicrosoftPhoto"));
    else router.refresh();
  }

  function onCropped(blob: Blob) {
    setCropping(null);
    startTransition(() => uploadAvatar(blob));
  }

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const res = await updateProfile({
          name,
          title,
          bio,
          timezone,
          workingHours: hours,
        });
        if (res.success) {
          toast.success(res.message);
          router.refresh();
        } else toast.error(res.message);
      } catch {
        toast.error(tCommon("errorGeneric"));
      }
    });
  }

  return (
    <form onSubmit={onSave} className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <UserAvatar user={user} size="lg" />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => fileInput.current?.click()}
          >
            {t("uploadAvatar")}
          </Button>
          {hasMicrosoft && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => startTransition(importMicrosoftAvatar)}
            >
              {t("useMicrosoftPhoto")}
            </Button>
          )}
          {user.image && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => startTransition(removeAvatar)}
            >
              {t("removeAvatar")}
            </Button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setCropping(f);
            e.target.value = "";
          }}
        />
      </div>
      {cropping && (
        <AvatarCropper
          file={cropping}
          onCancel={() => setCropping(null)}
          onCropped={onCropped}
        />
      )}

      <div className="grid gap-2">
        <Label htmlFor="pf-name">{t("name")}</Label>
        <Input
          id="pf-name"
          value={name}
          maxLength={PROFILE_LIMITS.name}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pf-title">{t("jobTitle")}</Label>
        <Input
          id="pf-title"
          value={title}
          maxLength={PROFILE_LIMITS.title}
          placeholder={t("jobTitlePlaceholder")}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pf-bio">{t("bio")}</Label>
        <Textarea
          id="pf-bio"
          value={bio}
          maxLength={PROFILE_LIMITS.bio}
          rows={3}
          onChange={(e) => setBio(e.target.value)}
        />
        <p className="text-end text-xs text-muted-foreground">
          {bio.length}/{PROFILE_LIMITS.bio}
        </p>
      </div>
      <div className="grid gap-2">
        <Label>{t("timezone")}</Label>
        <div className="flex gap-2">
          <div className="flex-1">
            <TimezoneSelect
              value={timezone}
              defaultZone={appTimeZone}
              onChange={setTimezone}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)
            }
          >
            {t("detectTimezone")}
          </Button>
        </div>
      </div>
      <div className="grid gap-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="pf-hours">{t("workingHours")}</Label>
          <Switch
            id="pf-hours"
            checked={hours !== null}
            onCheckedChange={(on) => setHours(on ? DEFAULT_HOURS : null)}
          />
        </div>
        {hours && (
          <>
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label={t("workingDays")}
            >
              {weekdays.map(({ d, label }) => {
                const on = hours.days.includes(d);
                return (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    aria-pressed={on}
                    onClick={() =>
                      setHours({
                        ...hours,
                        days: on
                          ? hours.days.filter((x) => x !== d)
                          : [...hours.days, d].sort((a, b) => a - b),
                      })
                    }
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                className="w-32"
                aria-label={t("start")}
                value={hours.start}
                onChange={(e) => setHours({ ...hours, start: e.target.value })}
              />
              <span aria-hidden>–</span>
              <Input
                type="time"
                className="w-32"
                aria-label={t("end")}
                value={hours.end}
                onChange={(e) => setHours({ ...hours, end: e.target.value })}
              />
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {t("save")}
        </Button>
        <Link
          href={`/people/${user.id}`}
          className="text-sm underline underline-offset-2"
        >
          {t("viewPublicProfile")}
        </Link>
      </div>
    </form>
  );
}
