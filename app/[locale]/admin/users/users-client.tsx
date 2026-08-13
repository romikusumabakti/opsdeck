"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Mail, Pencil, Send, Trash2, UserCog, UserPlus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  bulkDeleteUsers,
  bulkRevokeInvitations,
  deleteUser,
  inviteUser,
  resendInvitation,
  revokeInvitation,
  updateUserName,
  updateUserRole,
} from "@/actions/users";
import { useDialog } from "@/components/dialog-provider";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ASSIGNABLE_ROLES,
  isAssignableRole,
  ROLE_ADMIN,
  ROLE_MEMBER,
  type UserRole,
} from "@/lib/roles";

const ROLE_OPTIONS: readonly UserRole[] = [ROLE_MEMBER, ROLE_ADMIN] as const;

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string;
  createdAt: Date;
  lastActiveAt: Date | null;
};

type InvitationRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
};

function getInitials(value: string) {
  return value
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function UsersClient({
  users,
  invitations,
  currentUserId,
}: {
  users: UserRow[];
  invitations: InvitationRow[];
  currentUserId: string;
}) {
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();
  const [inviteOpen, setInviteOpen] = React.useState(false);

  // Optimistic state for the pending invitations list. When a new invite is
  // sent, we render a placeholder row immediately so the user sees the result
  // of their action before the server round-trip + revalidatePath completes.
  // React rolls this back automatically when the transition resolves.
  type OptimisticAction =
    | { type: "add"; invitation: InvitationRow }
    | { type: "remove"; ids: string[] }
    | { type: "renew"; id: string; expiresAt: Date };
  const [optimisticInvitations, applyOptimistic] = useOptimistic<
    InvitationRow[],
    OptimisticAction
  >(invitations, (state, action) => {
    if (action.type === "add") return [...state, action.invitation];
    if (action.type === "renew") {
      return state.map((inv) =>
        inv.id === action.id ? { ...inv, expiresAt: action.expiresAt } : inv
      );
    }
    return state.filter((inv) => !action.ids.includes(inv.id));
  });

  // Same pattern for the users list — drop the row(s) immediately on delete,
  // or flip the role/name inline on update.
  type OptimisticUserAction =
    | { type: "remove"; ids: string[] }
    | { type: "updateRole"; id: string; role: UserRole }
    | { type: "updateName"; id: string; name: string };
  const [optimisticUsers, applyOptimisticUsers] = useOptimistic<
    UserRow[],
    OptimisticUserAction
  >(users, (state, action) => {
    if (action.type === "remove") {
      return state.filter((u) => !action.ids.includes(u.id));
    }
    if (action.type === "updateRole") {
      return state.map((u) =>
        u.id === action.id ? { ...u, role: action.role } : u
      );
    }
    return state.map((u) =>
      u.id === action.id ? { ...u, name: action.name } : u
    );
  });

  const schema = z.object({
    name: z.string().min(1, tCommon("required")),
    email: z.string().email(tCommon("emailInvalid")),
    role: z.enum([ROLE_MEMBER, ROLE_ADMIN]),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", role: ROLE_MEMBER },
  });

  function onInvite(values: z.infer<typeof schema>) {
    startTransition(async () => {
      applyOptimistic({
        type: "add",
        invitation: {
          id: `optimistic-${Date.now()}`,
          name: values.name,
          email: values.email,
          role: values.role,
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
          createdAt: new Date(),
        },
      });
      const result = await inviteUser(values);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      form.reset({ name: "", email: "", role: ROLE_MEMBER });
      setInviteOpen(false);
    });
  }

  // Reset the form whenever the dialog closes (cancel, Esc, backdrop, or a
  // successful invite) so the next open starts clean.
  const onInviteOpenChange = React.useCallback(
    (open: boolean) => {
      setInviteOpen(open);
      if (!open) form.reset({ name: "", email: "", role: ROLE_MEMBER });
    },
    [form]
  );

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
        applyOptimisticUsers({ type: "remove", ids: [user.id] });
        const result = await deleteUser(user.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("deletedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimisticUsers]
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
        applyOptimisticUsers({
          type: "updateName",
          id: user.id,
          name: trimmed,
        });
        const result = await updateUserName({
          userId: user.id,
          name: trimmed,
        });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("renamedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimisticUsers]
  );

  const onChangeRole = React.useCallback(
    async (user: UserRow, role: UserRole) => {
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
        applyOptimisticUsers({ type: "updateRole", id: user.id, role });
        const result = await updateUserRole({ userId: user.id, role });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("roleChangedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimisticUsers]
  );

  const onRevoke = React.useCallback(
    async (inv: InvitationRow) => {
      const ok = await dialog.confirm({
        title: t("revokeTitle"),
        description: t("revokeDescription", { email: inv.email }),
        confirmText: t("revoke"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "remove", ids: [inv.id] });
        const result = await revokeInvitation(inv.id);
        if (!result.success) {
          toast.error(result.message ?? "");
          return;
        }
        toast.success(result.message ?? t("revokedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onResend = React.useCallback(
    async (inv: InvitationRow) => {
      const ok = await dialog.confirm({
        title: t("resendTitle"),
        description: t("resendDescription", { email: inv.email }),
        confirmText: t("resend"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({
          type: "renew",
          id: inv.id,
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
        });
        const result = await resendInvitation(inv.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("resendSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onBulkDeleteUsers = React.useCallback(
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
        applyOptimisticUsers({ type: "remove", ids: targets });
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
    [dialog, t, tCommon, currentUserId, applyOptimisticUsers, users]
  );

  const onBulkRevoke = React.useCallback(
    async (ids: string[], clearSelection: () => void) => {
      const ok = await dialog.confirm({
        title: t("bulkRevokeTitle", { count: ids.length }),
        description: t("bulkRevokeDescription"),
        confirmText: t("revoke"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "remove", ids });
        clearSelection();
        const result = await bulkRevokeInvitations(ids);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(t("bulkRevokedSuccess", { count: result.revoked }));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const renderUserActions = React.useCallback(
    (user: UserRow) => {
      const isSelf = user.id === currentUserId;
      const renameLabel = t("renameAction");
      const roleLabel = t("roleChangeTitle");
      const deleteLabel = tCommon("delete");
      // Inline instead of a kebab menu so every action is one click away. Role
      // change and delete both still route through a confirm dialog, so a
      // stray click can't act on a user unattended. Actions barred on your own
      // row render disabled rather than absent, so the icon columns stay
      // aligned down the table and the title says why they're unavailable.
      return (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={renameLabel}
            title={renameLabel}
            disabled={isPending}
            onClick={() => onRename(user)}
          >
            <Pencil className="size-4" />
          </Button>
          {/* A menu rather than an admin/member toggle: there are four roles,
              and users who sign in with Microsoft start at `viewer`, so the
              common promotion is viewer → member — a toggle would jump them
              straight to admin. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={isSelf ? t("cannotChangeOwnRole") : roleLabel}
                  title={isSelf ? t("cannotChangeOwnRole") : roleLabel}
                  disabled={isPending || isSelf}
                />
              }
            >
              <UserCog className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ASSIGNABLE_ROLES.map((r) => (
                <DropdownMenuItem
                  key={r}
                  disabled={r === user.role}
                  onClick={() => onChangeRole(user, r)}
                >
                  {t(`role.${r}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={isSelf ? t("cannotDeleteSelf") : deleteLabel}
            title={isSelf ? t("cannotDeleteSelf") : deleteLabel}
            disabled={isPending || isSelf}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(user)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      );
    },
    [currentUserId, t, tCommon, isPending, onDelete, onChangeRole, onRename]
  );

  const renderUserIdentity = React.useCallback(
    (user: UserRow) => {
      const isYou = user.id === currentUserId;
      return (
        <div className="flex items-center gap-3 min-w-0">
          <span className="size-9 rounded-full bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
            {getInitials(user.name || user.email)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{user.name}</span>
              {isYou && (
                <Badge variant="secondary" className="text-xs">
                  {tCommon("you")}
                </Badge>
              )}
              <RoleBadge role={user.role} t={t} />
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {user.email}
            </div>
          </div>
        </div>
      );
    },
    [currentUserId, t, tCommon]
  );

  const renderUserCard = React.useCallback(
    (user: UserRow) => (
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          {renderUserIdentity(user)}
          {renderUserActions(user)}
        </div>
        <div className="ps-12 text-sm text-muted-foreground">
          {user.lastActiveAt
            ? format.relativeTime(new Date(user.lastActiveAt))
            : t("neverActive")}
        </div>
      </div>
    ),
    [renderUserIdentity, renderUserActions, t, format]
  );

  const userColumns = React.useMemo<DataTableColumnDef<UserRow>[]>(
    () => [
      {
        accessorKey: "name",
        enableHiding: false,
        meta: { label: t("colUser") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colUser")} />
        ),
        cell: ({ row }) => renderUserIdentity(row.original),
      },
      {
        accessorKey: "lastActiveAt",
        meta: { label: t("colLastActive") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colLastActive")} />
        ),
        cell: ({ row }) => {
          const at = row.original.lastActiveAt;
          if (!at) {
            return (
              <span className="text-sm text-muted-foreground">
                {t("neverActive")}
              </span>
            );
          }
          const date = new Date(at);
          return (
            <span
              className="text-sm text-muted-foreground"
              title={format.dateTime(date, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            >
              {format.relativeTime(date)}
            </span>
          );
        },
      },
      {
        id: "actions",
        enableHiding: false,
        meta: { headClassName: "w-32", cellClassName: "w-32" },
        cell: ({ row }) => renderUserActions(row.original),
      },
    ],
    [t, format, renderUserIdentity, renderUserActions]
  );

  const invitationColumns = React.useMemo<DataTableColumnDef<InvitationRow>[]>(
    () => [
      {
        accessorKey: "name",
        meta: { label: t("colInvitee") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colInvitee")} />
        ),
        cell: ({ row }) => {
          const inv = row.original;
          return (
            <div className="flex items-center gap-3">
              <span className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Mail className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{inv.name}</span>
                  <RoleBadge role={inv.role} t={t} />
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {inv.email}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "expiresAt",
        meta: { label: t("colExpires") },
        header: t("colExpires"),
        cell: ({ row }) => {
          const expiresAt = new Date(row.getValue("expiresAt") as Date);
          const isExpired = expiresAt.getTime() < Date.now();
          return (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {format.dateTime(expiresAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              {isExpired && (
                <Badge variant="destructive" className="text-xs">
                  {t("expiredBadge")}
                </Badge>
              )}
            </div>
          );
        },
      },
      {
        id: "actions",
        enableHiding: false,
        meta: { headClassName: "w-24", cellClassName: "w-24" },
        cell: ({ row }) => {
          const inv = row.original;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("resend")}
                title={t("resend")}
                disabled={isPending}
                onClick={() => onResend(inv)}
              >
                <Send className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("revoke")}
                title={t("revoke")}
                disabled={isPending}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onRevoke(inv)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          );
        },
      },
    ],
    [t, isPending, onRevoke, onResend, format]
  );

  // Split invitations by lifecycle so the "Pending" heading never lies: a link
  // past its expiry lives in its own "Expired" table (resend to renew), while
  // Pending only holds still-actionable invites.
  const nowMs = Date.now();
  const pendingInvitations = optimisticInvitations.filter(
    (inv) => new Date(inv.expiresAt).getTime() >= nowMs
  );
  const expiredInvitations = optimisticInvitations.filter(
    (inv) => new Date(inv.expiresAt).getTime() < nowMs
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="size-4" />
            {t("inviteCardTitle")}
          </Button>
        }
      />

      <Dialog open={inviteOpen} onOpenChange={onInviteOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("inviteCardTitle")}</DialogTitle>
            <DialogDescription>{t("inviteCardDescription")}</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onInvite)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("fullName")}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t("fullNamePlaceholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("email")}</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder={t("emailPlaceholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("roleLabel")}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v ?? "")}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ROLE_OPTIONS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(`role.${r}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onInviteOpenChange(false)}
                >
                  {tCommon("cancel")}
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  <UserPlus className="size-4" />
                  {form.formState.isSubmitting
                    ? t("inviteSubmitting")
                    : t("inviteSubmit")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* One list per tab. Each section is an independent table, so tabs let a
          single table own the viewport and scroll its own body (fixed header +
          footer) — stacking them as cards can't keep every header/footer
          visible at once. Invitation tabs only appear when they have rows. */}
      <Tabs defaultValue="users" className="flex flex-1 min-h-0 flex-col gap-4">
        <TabsList className="shrink-0">
          <TabsTrigger value="users">
            {t("listCardTitle")}
            <span className="text-muted-foreground">
              {optimisticUsers.length}
            </span>
          </TabsTrigger>
          {pendingInvitations.length > 0 && (
            <TabsTrigger value="pending">
              {t("pendingTitle")}
              <span className="text-muted-foreground">
                {pendingInvitations.length}
              </span>
            </TabsTrigger>
          )}
          {expiredInvitations.length > 0 && (
            <TabsTrigger value="expired">
              {t("expiredTitle")}
              <span className="text-muted-foreground">
                {expiredInvitations.length}
              </span>
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="users" className="flex flex-1 min-h-0 flex-col">
          <DataTable
            fillHeight
            columns={userColumns}
            data={optimisticUsers}
            initialPageSize={25}
            filterColumn="name"
            filterPlaceholder={t("searchPlaceholder")}
            getRowId={(row) => row.id}
            canSelectRow={(row) => row.id !== currentUserId}
            urlKey="usr"
            renderCard={renderUserCard}
            bulkActions={(ids, clearSelection) => (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onBulkDeleteUsers(ids, clearSelection)}
                disabled={isPending}
              >
                <Trash2 className="size-4" />
                {t("bulkDelete")}
              </Button>
            )}
          />
        </TabsContent>

        {pendingInvitations.length > 0 && (
          <TabsContent value="pending" className="flex flex-1 min-h-0 flex-col">
            <DataTable
              fillHeight
              columns={invitationColumns}
              data={pendingInvitations}
              initialPageSize={25}
              getRowId={(row) => row.id}
              filterColumn="name"
              filterPlaceholder={t("searchPlaceholder")}
              urlKey="inv"
              bulkActions={(ids, clearSelection) => (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => onBulkRevoke(ids, clearSelection)}
                  disabled={isPending}
                >
                  <Trash2 className="size-4" />
                  {t("bulkRevoke")}
                </Button>
              )}
            />
          </TabsContent>
        )}

        {expiredInvitations.length > 0 && (
          <TabsContent value="expired" className="flex flex-1 min-h-0 flex-col">
            <DataTable
              fillHeight
              columns={invitationColumns}
              data={expiredInvitations}
              initialPageSize={25}
              getRowId={(row) => row.id}
              filterColumn="name"
              filterPlaceholder={t("searchPlaceholder")}
              urlKey="invx"
              bulkActions={(ids, clearSelection) => (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => onBulkRevoke(ids, clearSelection)}
                  disabled={isPending}
                >
                  <Trash2 className="size-4" />
                  {t("bulkRevoke")}
                </Button>
              )}
            />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

function RoleBadge({ role, t }: { role: string; t: (key: string) => string }) {
  // Unknown/legacy role strings render verbatim rather than blowing up on a
  // missing translation key — matches how roleRank() floors them to viewer.
  const known = isAssignableRole(role);
  const label = known ? t(`role.${role}`) : role;
  return (
    <Badge
      variant={role === ROLE_ADMIN ? "default" : "secondary"}
      className="text-xs"
    >
      {label}
    </Badge>
  );
}
