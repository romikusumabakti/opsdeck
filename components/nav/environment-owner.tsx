import { useTranslations } from "use-intl";
import { UserAvatar } from "@/components/user/user-avatar";
import type { EnvironmentOwner as Owner } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

// "Owner: <avatar> <name>" for an environment, as muted secondary text. An
// offboarded (banned) owner stays linked and is marked "Deactivated". Plain
// text, not a profile link, so it can sit inside a clickable row. Renders
// nothing when no owner is set.
export function EnvironmentOwner({
  owner,
  className,
}: {
  owner: Owner | null | undefined;
  className?: string;
}) {
  const t = useTranslations("home");
  const tPeople = useTranslations("people");
  if (!owner) return null;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
        className
      )}
    >
      {t.rich("ownedBy", {
        name: owner.name,
        owner: (chunks) => (
          <span className="flex min-w-0 items-center gap-1">
            <UserAvatar user={owner} size="xs" />
            <span className="truncate">{chunks}</span>
            {owner.banned && (
              <span className="shrink-0 italic">
                ({tPeople("deactivated")})
              </span>
            )}
          </span>
        ),
      })}
    </span>
  );
}
