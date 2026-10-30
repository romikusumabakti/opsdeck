import { Mail, MessageSquare, SquareArrowOutUpRight } from "lucide-react";
import { use } from "react";
import { useFormatter, useTranslations } from "use-intl";
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
          {/* The name is the way to the full profile, as on GitHub or Slack. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/people/${id}`}
              className="truncate font-semibold underline-offset-2 hover:underline"
            >
              {card.name}
            </Link>
            <Badge variant="outline">{tRoles(card.role)}</Badge>
            {card.deactivated && (
              <Badge variant="secondary">{t("deactivated")}</Badge>
            )}
          </div>
          {card.title && (
            <p className="truncate text-muted-foreground">{card.title}</p>
          )}
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
      <div className="text-xs">
        <LocalTime timeZone={card.timeZone} workingHours={card.workingHours} />
      </div>
      {card.bio && (
        <p className="line-clamp-2 text-sm text-muted-foreground whitespace-pre-line">
          {card.bio}
        </p>
      )}
      <div className="flex gap-2">
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
            {/* Product name, the same in every locale; keeps the row to one line. */}
            Jira
          </Button>
        )}
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
