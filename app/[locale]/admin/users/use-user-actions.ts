"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { useTransition } from "react";
import { toast } from "sonner";
import { offboardUser } from "@/actions/access";
import { adminRemoveAvatar, adminUpdateProfile } from "@/actions/profile";
import { bulkDeleteUsers, deleteUser, updateUserRole } from "@/actions/users";
import { useDialog } from "@/components/dialog-provider";
import type { OrgRole } from "@/lib/permissions";
import type { UserAction, UserRow } from "./types";

// Confirm-then-act handlers for the Users tab. Each applies its optimistic
// edit inside the transition, so the row updates before the server answers
// and React rolls it back if the action fails.
export function useUserActions({
  users,
  currentUserId,
  applyOptimistic,
}: {
  users: UserRow[];
  currentUserId: string;
  applyOptimistic: (action: UserAction) => void;
}) {
  const t = useTranslations("users");
  const tAccess = useTranslations("access");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  const onDelete = React.useCallback(
    async (user: UserRow) => {
      const ok = await dialog.confirmTyping({
        title: t("deleteTitle"),
        description: t("deleteDescription", {
          name: user.name,
          email: user.email,
        }),
        phrase: user.email,
        phraseLabel: tCommon("confirmTypingLabel"),
        placeholder: tCommon("confirmTypingPlaceholder"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "remove", ids: [user.id] });
        const result = await deleteUser(user.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("deletedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onRename = React.useCallback(
    async (user: UserRow) => {
      const next = await dialog.prompt({
        title: t("renameTitle"),
        description: t("renameDescription", { name: user.name }),
        defaultValue: user.name,
        placeholder: t("fullNamePlaceholder"),
        confirmText: tCommon("save"),
        cancelText: tCommon("cancel"),
      });
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === user.name) return;
      startTransition(async () => {
        applyOptimistic({ type: "updateName", id: user.id, name: trimmed });
        const result = await adminUpdateProfile({
          userId: user.id,
          name: trimmed,
          title: user.title ?? null,
        });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("renamedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onRemoveAvatar = React.useCallback(
    async (user: UserRow) => {
      const ok = await dialog.confirm({
        title: t("removeAvatarTitle"),
        description: t("removeAvatarDescription", { name: user.name }),
        confirmText: t("removeAvatarConfirm"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "removeImage", id: user.id });
        const result = await adminRemoveAvatar({ userId: user.id });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message);
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onChangeRole = React.useCallback(
    async (user: UserRow, role: OrgRole) => {
      const ok = await dialog.confirm({
        title: t("roleChangeTitle"),
        description: t("roleChangeDescription", {
          name: user.name,
          role: t(`role.${role}`),
        }),
        confirmText: t("roleChangeConfirm"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "updateRole", id: user.id, role });
        const result = await updateUserRole({ userId: user.id, role });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("roleChangedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onOffboard = React.useCallback(
    async (user: UserRow) => {
      const ok = await dialog.confirm({
        title: tAccess("offboardTitle"),
        description: tAccess("offboardConfirm", { name: user.name }),
        confirmText: tAccess("offboard"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "offboard", id: user.id });
        const result = await offboardUser(user.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? tAccess("offboarded"));
      });
    },
    [dialog, tAccess, tCommon, applyOptimistic]
  );

  const onBulkDelete = React.useCallback(
    async (ids: string[], clearSelection: () => void) => {
      const targets = ids.filter((id) => id !== currentUserId);
      if (targets.length === 0) {
        toast.warning(t("bulkDeletedNothing"));
        clearSelection();
        return;
      }
      const ok = await dialog.confirm({
        title: t("bulkDeleteTitle", { count: targets.length }),
        description: t("bulkDeleteDescription"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "remove", ids: targets });
        clearSelection();
        const result = await bulkDeleteUsers(targets);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        if (result.failed.length === 0) {
          toast.success(t("bulkDeletedSuccess", { count: result.deleted }));
        } else {
          const failedNames = result.failed
            .map((f) => users.find((u) => u.id === f.id)?.name ?? f.id)
            .join(", ");
          toast.warning(
            t("bulkDeletedPartial", {
              deleted: result.deleted,
              failed: result.failed.length,
            }),
            { description: failedNames }
          );
        }
      });
    },
    [dialog, t, tCommon, currentUserId, applyOptimistic, users]
  );

  // Memoized so the table's column definitions stay stable between renders.
  return React.useMemo(
    () => ({
      isPending,
      onDelete,
      onRename,
      onRemoveAvatar,
      onChangeRole,
      onOffboard,
      onBulkDelete,
    }),
    [
      isPending,
      onDelete,
      onRename,
      onRemoveAvatar,
      onChangeRole,
      onOffboard,
      onBulkDelete,
    ]
  );
}

export type UserActionHandlers = ReturnType<typeof useUserActions>;
