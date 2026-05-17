"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowUpDown,
  Mail,
  MoreHorizontal,
  Pencil,
  Send,
  ShieldCheck,
  Trash2,
  UserCog,
  UserPlus,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { ROLE_ADMIN, ROLE_MEMBER, type UserRole } from "@/lib/roles";
import { cn } from "@/lib/utils";

const ROLE_OPTIONS: readonly UserRole[] = [ROLE_MEMBER, ROLE_ADMIN] as const;

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string;
  createdAt: Date;
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
    });
  }

  const onDelete = React.useCallback(
    async (user: UserRow) => {
      const ok = await dialog.confirm({
        title: t("deleteTitle"),
        description: t("deleteDescription", {
          name: user.name,
          email: user.email,
        }),
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
          toast.warning(
            t("bulkDeletedPartial", {
              deleted: result.deleted,
              failed: result.failed.length,
            })
          );
        }
      });
    },
    [dialog, t, tCommon, currentUserId, applyOptimisticUsers]
  );

  const onBulkRevoke = React.useCallback(
    async (ids: string[], clearSelection: () => void) => {
      const ok = await dialog.confirm({
        title: t("bulkRevokeTitle", { count: ids.length }),
        description: t("bulkRevokeDescription"),
        confirmText: t("revoke"),
        cancelText: tCommon("cancel"),
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

  const userColumns = React.useMemo<ColumnDef<UserRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            {t("colUser")}
            <ArrowUpDown className="size-3.5" />
          </Button>
        ),
        cell: ({ row }) => {
          const user = row.original;
          const isYou = user.id === currentUserId;
          return (
            <div className="flex items-center gap-3">
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
      },
      {
        id: "actions",
        meta: { headClassName: "w-12", cellClassName: "w-12" },
        cell: ({ row }) => {
          const user = row.original;
          const isSelf = user.id === currentUserId;
          const isAdmin = user.role === ROLE_ADMIN;
          const nextRole: UserRole = isAdmin ? ROLE_MEMBER : ROLE_ADMIN;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tCommon("openMenu")}
                  disabled={isPending}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{tCommon("actions")}</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onRename(user)}>
                  <Pencil className="size-4" />
                  {t("renameAction")}
                </DropdownMenuItem>
                {!isSelf && (
                  <DropdownMenuItem
                    onClick={() => onChangeRole(user, nextRole)}
                  >
                    {isAdmin ? (
                      <UserCog className="size-4" />
                    ) : (
                      <ShieldCheck className="size-4" />
                    )}
                    {t(`roleChangeTo.${nextRole}`)}
                  </DropdownMenuItem>
                )}
                {!isSelf && <DropdownMenuSeparator />}
                {!isSelf && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onDelete(user)}
                  >
                    <Trash2 className="size-4" />
                    {tCommon("delete")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [currentUserId, t, tCommon, isPending, onDelete, onChangeRole, onRename]
  );

  const invitationColumns = React.useMemo<ColumnDef<InvitationRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            {t("colInvitee")}
            <ArrowUpDown className="size-3.5" />
          </Button>
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
        meta: { headClassName: "w-12", cellClassName: "w-12" },
        cell: ({ row }) => {
          const inv = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tCommon("openMenu")}
                  disabled={isPending}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{tCommon("actions")}</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onResend(inv)}>
                  <Send className="size-4" />
                  {t("resend")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onRevoke(inv)}
                >
                  <Trash2 className="size-4" />
                  {t("revoke")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [t, tCommon, isPending, onRevoke, onResend, format]
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("inviteCardTitle")}</CardTitle>
          <CardDescription>{t("inviteCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onInvite)}
              className="flex flex-col gap-4 md:flex-row md:items-start"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="flex-1">
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
                  <FormItem className="flex-1">
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
                  <FormItem className="md:w-40">
                    <FormLabel>{t("roleLabel")}</FormLabel>
                    <FormControl>
                      <RoleSelect {...field}>
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {t(`role.${r}`)}
                          </option>
                        ))}
                      </RoleSelect>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="md:mt-6"
              >
                <UserPlus className="size-4" />
                {form.formState.isSubmitting
                  ? t("inviteSubmitting")
                  : t("inviteSubmit")}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {optimisticInvitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              {t("pendingTitle")}{" "}
              <span className="text-muted-foreground font-normal">
                ({optimisticInvitations.length})
              </span>
            </CardTitle>
            <CardDescription>{t("pendingDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={invitationColumns}
              data={optimisticInvitations}
              initialPageSize={5}
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
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {t("listCardTitle")}{" "}
            <span className="text-muted-foreground font-normal">
              ({optimisticUsers.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={userColumns}
            data={optimisticUsers}
            filterColumn="name"
            filterPlaceholder={t("searchPlaceholder")}
            getRowId={(row) => row.id}
            canSelectRow={(row) => row.id !== currentUserId}
            urlKey="usr"
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
        </CardContent>
      </Card>
    </div>
  );
}

function RoleBadge({ role, t }: { role: string; t: (key: string) => string }) {
  const known = role === ROLE_ADMIN || role === ROLE_MEMBER;
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

function RoleSelect({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "border-input bg-transparent dark:bg-input/30 h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}
