"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowUpDown,
  Mail,
  MoreHorizontal,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { deleteUser, inviteUser, revokeInvitation } from "@/actions/users";
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
    | { type: "remove"; id: string };
  const [optimisticInvitations, applyOptimistic] = useOptimistic<
    InvitationRow[],
    OptimisticAction
  >(invitations, (state, action) => {
    if (action.type === "add") return [...state, action.invitation];
    return state.filter((inv) => inv.id !== action.id);
  });

  // Same pattern for the users list — drop the row immediately on delete.
  const [optimisticUsers, removeOptimisticUser] = useOptimistic<
    UserRow[],
    string
  >(users, (state, idToRemove) => state.filter((u) => u.id !== idToRemove));

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
        removeOptimisticUser(user.id);
        const result = await deleteUser(user.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("deletedSuccess"));
      });
    },
    [dialog, t, tCommon, removeOptimisticUser]
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
        applyOptimistic({ type: "remove", id: inv.id });
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
          if (user.id === currentUserId) return null;
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
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDelete(user)}
                >
                  <Trash2 className="size-4" />
                  {tCommon("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [currentUserId, t, tCommon, isPending, onDelete]
  );

  const invitationColumns = React.useMemo<ColumnDef<InvitationRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("colInvitee"),
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
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {format.dateTime(new Date(row.getValue("expiresAt") as Date), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        ),
      },
      {
        id: "actions",
        meta: { headClassName: "w-12", cellClassName: "w-12" },
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(row.original)}
            disabled={isPending}
          >
            {t("revoke")}
          </Button>
        ),
      },
    ],
    [t, isPending, onRevoke, format]
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
