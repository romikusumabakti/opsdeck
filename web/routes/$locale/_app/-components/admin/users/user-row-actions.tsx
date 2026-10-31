import { ImageOff, Pencil, Trash2, UserCog, UserX } from "lucide-react";
import { useTranslations } from "use-intl";
import { type RowAction, RowActions } from "@/components/ui/row-actions";
import { ORG_ROLES } from "@/lib/permissions";
import type { UserRow } from "./types";
import type { UserActionHandlers } from "./use-user-actions";

export type UserPermissions = {
  canRename: boolean;
  canSetRole: boolean;
  canOffboard: boolean;
  canDelete: boolean;
};

// Edit (rename) is the primary button; everything else lives in the ⋯ menu and
// each still routes through a confirm dialog, so a stray click can't act
// unattended. Actions barred on your own row stay visible but disabled, with
// the reason shown under the label. Actions that make no sense for a banned
// user are left out.
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

  const items: RowAction[] = [];
  // Same permission as rename (user:update).
  if (perms.canRename) {
    items.push({
      label: t("removeAvatarAction"),
      icon: ImageOff,
      disabled: !user.image,
      disabledReason: t("noAvatar"),
      onSelect: () => actions.onRemoveAvatar(user),
    });
  }
  // The only place an org role is edited. A submenu rather than an
  // admin/member toggle: there are four roles and new sign-ins start at
  // `member`, so a toggle would skip infra/observer.
  if (perms.canSetRole && !user.banned) {
    items.push({
      label: t("roleChangeTitle"),
      icon: UserCog,
      disabled: isSelf,
      disabledReason: t("cannotChangeOwnRole"),
      submenu: ORG_ROLES.map((r) => ({
        label: t(`role.${r}`),
        disabled: r === user.role,
        onSelect: () => actions.onChangeRole(user, r),
      })),
    });
  }
  if (perms.canOffboard && !user.banned) {
    items.push({
      label: tAccess("offboard"),
      icon: UserX,
      destructive: true,
      disabled: isSelf,
      disabledReason: tAccess("errorSelf"),
      onSelect: () => actions.onOffboard(user),
    });
  }
  if (perms.canDelete) {
    items.push({
      label: tCommon("delete"),
      icon: Trash2,
      destructive: true,
      disabled: isSelf,
      disabledReason: t("cannotDeleteSelf"),
      onSelect: () => actions.onDelete(user),
    });
  }

  return (
    <RowActions
      label={tCommon("openMenu")}
      disabled={actions.isPending}
      primary={
        perms.canRename
          ? {
              label: t("renameAction"),
              icon: Pencil,
              onSelect: () => actions.onRename(user),
            }
          : undefined
      }
      items={items}
    />
  );
}
