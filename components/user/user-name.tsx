"use client";

import { useTranslations } from "next-intl";
import { Component, type ReactNode, Suspense, useState } from "react";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/components/ui/preview-card";
import { Link } from "@/i18n/navigation";
import type { UserCardData, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type AvatarSize, UserAvatar } from "./user-avatar";
import { UserCardBody, UserCardSkeleton } from "./user-card";
import { loadUserCard } from "./user-card-cache";

class CardBoundary extends Component<
  { fallback: ReactNode; children: ReactNode; resetKey: unknown },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  // A new request (retry after failure, or a refetch past the cache TTL) clears the error.
  componentDidUpdate(prev: { resetKey: unknown }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A user's name as a link to their profile, with a hover/focus card. On touch
 * devices the card doesn't open and a tap navigates. Everything on the card
 * is also on the profile page.
 */
export function UserName({
  user,
  avatar,
  className,
}: {
  user: UserRef | null;
  avatar?: AvatarSize | boolean;
  className?: string;
}) {
  const t = useTranslations("people");
  const [promise, setPromise] = useState<Promise<UserCardData> | null>(null);
  if (!user) return <span className={cn("text-muted-foreground", className)}>{t("deletedUser")}</span>;

  // Start fetching on intent, before the open delay elapses. loadUserCard dedupes
  // within its TTL (same promise, stable identity), refetches after it, and
  // retries after a failure, so the card never pins stale or failed data.
  const prefetch = () => setPromise(loadUserCard(user.id));
  const size: AvatarSize = avatar === true ? "xs" : avatar || "xs";

  return (
    <PreviewCard onOpenChange={(open) => open && prefetch()}>
      <PreviewCardTrigger
        render={<Link href={`/people/${user.id}`} />}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        className={cn("inline-flex min-w-0 items-center gap-1.5 hover:underline underline-offset-2", className)}
      >
        {avatar ? <UserAvatar user={user} size={size} /> : null}
        <span className="truncate">{user.name}</span>
      </PreviewCardTrigger>
      <PreviewCardContent>
        {promise && (
          <CardBoundary resetKey={promise} fallback={<Link href={`/people/${user.id}`} className="font-medium hover:underline">{user.name} · {t("viewProfile")}</Link>}>
            <Suspense fallback={<UserCardSkeleton />}>
              <UserCardBody promise={promise} fallbackName={user.name} id={user.id} />
            </Suspense>
          </CardBoundary>
        )}
      </PreviewCardContent>
    </PreviewCard>
  );
}
