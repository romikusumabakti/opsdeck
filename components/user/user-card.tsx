"use client";

import { Mail, MessageSquare, SquareArrowOutUpRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { use } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { teamsChatUrl } from "@/lib/people/links";
import type { UserCardData } from "@/lib/types";
import { liveCardStatus } from "@/lib/user-display";
import { LocalTime } from "./local-time";
import { UserAvatar } from "./user-avatar";

export function UserCardBody({
  promise,
  fallbackName,
  id,
}: {
  promise: Promise<UserCardData>;
  fallbackName: string;
  id: string;
}) {
  const t = useTranslations("people");
  const tRoles = useTranslations("users.role");
  const format = useFormatter();
  const card = use(promise);
  // Re-checked on every render: a status that expired while the card sat open must go.
  const status = liveCardStatus(card.status);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <UserAvatar user={card} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{card.name}</span>
            {card.deactivated && (
              <Badge variant="secondary">{t("deactivated")}</Badge>
            )}
          </div>
          {card.title && (
            <p className="truncate text-muted-foreground">{card.title}</p>
          )}
          <Badge variant="outline" className="mt-1">
            {tRoles(card.role)}
          </Badge>
        </div>
      </div>
      {status && (
        <p className="text-sm">
          {status.emoji} {status.text}
          {status.expiresAt && (
            <span className="text-muted-foreground">
              {" · "}
              {t("until", {
                date: format.dateTime(new Date(status.expiresAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </span>
          )}
        </p>
      )}
      <p className="text-xs">
        <LocalTime timeZone={card.timeZone} workingHours={card.workingHours} />
      </p>
      {card.bio && (
        <p className="line-clamp-2 text-sm text-muted-foreground whitespace-pre-line">
          {card.bio}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={<a href={`mailto:${card.email}`} />}
        >
          <Mail />
          {t("email")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={
            <a
              href={teamsChatUrl(card.email)}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          <MessageSquare />
          {t("teams")}
        </Button>
        {card.jiraUrl && (
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<a href={card.jiraUrl} target="_blank" rel="noreferrer" />}
          >
            <SquareArrowOutUpRight />
            {t("jira")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          nativeButton={false}
          render={<Link href={`/people/${id}`} />}
        >
          <SquareArrowOutUpRight />
          {t("viewProfile")}
        </Button>
      </div>
      <span className="sr-only">{fallbackName}</span>
    </div>
  );
}

export function UserCardSkeleton() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="size-16 rounded-full" />
      <div className="flex flex-1 flex-col gap-2 pt-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}
