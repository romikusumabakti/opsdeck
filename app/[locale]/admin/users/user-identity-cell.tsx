"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/user/user-avatar";
import { UserName } from "@/components/user/user-name";
import { userStatus } from "@/lib/access";
import type { UserRow } from "./types";
import { RoleBadge, StatusBadge } from "./user-badges";

// Avatar, name, badges and email: the user cell shared by the Users and
// Project access tables. `showRole` is for layouts without an Org role column
// (the mobile cards).
export function UserIdentityCell({
  user,
  isSelf,
  now,
  showRole = false,
}: {
  user: UserRow;
  isSelf: boolean;
  now: Date;
  showRole?: boolean;
}) {
  const tCommon = useTranslations("common");
  return (
    <div className="flex items-center gap-3 min-w-0">
      <UserAvatar user={user} size="md" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <UserName user={user} className="font-medium truncate" />
          {isSelf && (
            <Badge variant="secondary" className="text-xs">
              {tCommon("you")}
            </Badge>
          )}
          {showRole && <RoleBadge role={user.role} />}
          <StatusBadge status={userStatus(user, now)} />
        </div>
        <div className="text-sm text-muted-foreground truncate">
          {user.email}
        </div>
      </div>
    </div>
  );
}
