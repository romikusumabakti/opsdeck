"use client";

import { ImageOff, Pencil, Trash2, UserCog, UserX } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ORG_ROLES } from "@/lib/permissions";
import type { UserRow } from "./types";
import type { UserActionHandlers } from "./use-user-actions";

export type UserPermissions = {
  canRename: boolean;
  canSetRole: boolean;
  canOffboard: boolean;
  canDelete: boolean;
};

const DESTRUCTIVE =
  "text-destructive hover:bg-destructive/10 hover:text-destructive";

// Inline instead of a kebab menu so every action is one click away; each still
// routes through a confirm dialog, so a stray click can't act unattended.
// Actions barred on your own row render disabled (the title says why), and
// actions that make no sense for a banned user leave an empty slot, so the
// icon columns stay aligned down the table.
export function UserRowActions({
  user,
  isSelf,
  perms,
  actions,
}: {
  user: UserRow;
  isSelf: boolean;
  perms: UserPermissions;
  actions: UserActionHandlers;
}) {
  const t = useTranslations("users");
  const tAccess = useTranslations("access");
  const tCommon = useTranslations("common");
  const { isPending } = actions;
  const renameLabel = t("renameAction");
  const removeAvatarLabel = user.image
    ? t("removeAvatarAction")
    : t("noAvatar");
  const roleLabel = isSelf ? t("cannotChangeOwnRole") : t("roleChangeTitle");
  const offboardLabel = isSelf ? tAccess("errorSelf") : tAccess("offboard");
  const deleteLabel = isSelf ? t("cannotDeleteSelf") : tCommon("delete");

  return (
    <div className="flex items-center justify-end gap-1">
      {perms.canRename && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={renameLabel}
          title={renameLabel}
          disabled={isPending}
          onClick={() => actions.onRename(user)}
        >
          <Pencil className="size-4" />
        </Button>
      )}
      {/* Same permission as rename (user:update). Disabled rather than absent
          without a photo, to keep the icon columns aligned. */}
      {perms.canRename && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={removeAvatarLabel}
          title={removeAvatarLabel}
          disabled={isPending || !user.image}
          onClick={() => actions.onRemoveAvatar(user)}
        >
          <ImageOff className="size-4" />
        </Button>
      )}
      {/* The only place an org role is edited. A menu rather than an
          admin/member toggle: there are four roles and new sign-ins start at
          `member`, so a toggle would skip infra/observer. */}
      {perms.canSetRole &&
        (user.banned ? (
          <Slot />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={roleLabel}
                  title={roleLabel}
                  disabled={isPending || isSelf}
                />
              }
            >
              <UserCog className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ORG_ROLES.map((r) => (
                <DropdownMenuItem
                  key={r}
                  disabled={r === user.role}
                  onClick={() => actions.onChangeRole(user, r)}
                >
                  {t(`role.${r}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      {perms.canOffboard &&
        (user.banned ? (
          <Slot />
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={offboardLabel}
            title={offboardLabel}
            disabled={isPending || isSelf}
            className={DESTRUCTIVE}
            onClick={() => actions.onOffboard(user)}
          >
            <UserX className="size-4" />
          </Button>
        ))}
      {perms.canDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={deleteLabel}
          title={deleteLabel}
          disabled={isPending || isSelf}
          className={DESTRUCTIVE}
          onClick={() => actions.onDelete(user)}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
}

// Holds an icon button's place when the action doesn't apply to the row.
function Slot() {
  return <span aria-hidden className="size-8 shrink-0" />;
}
