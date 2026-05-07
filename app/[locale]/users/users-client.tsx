"use client";

import { Clock, Mail, Trash2, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { deleteUser, inviteUser, revokeInvitation } from "@/actions/users";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
};

type InvitationRow = {
  id: string;
  email: string;
  name: string;
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
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function onInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await inviteUser({ name, email });
      if (!result.success) {
        setError(result.message);
      } else {
        setSuccess(result.message ?? "");
        setName("");
        setEmail("");
      }
    });
  }

  async function onDelete(user: UserRow) {
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
      const result = await deleteUser(user.id);
      if (!result.success) {
        await dialog.alert({
          title: t("deleteFailed"),
          description: result.message,
        });
      }
    });
  }

  async function onRevoke(inv: InvitationRow) {
    const ok = await dialog.confirm({
      title: t("revokeTitle"),
      description: t("revokeDescription", { email: inv.email }),
      confirmText: t("revoke"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    startTransition(async () => {
      await revokeInvitation(inv.id);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("inviteCardTitle")}</CardTitle>
          <CardDescription>{t("inviteCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onInvite}
            className="flex flex-col gap-4 md:flex-row md:items-end"
          >
            <div className="flex flex-col gap-2 flex-1">
              <Label htmlFor="invite-name">{t("fullName")}</Label>
              <Input
                id="invite-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("fullNamePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2 flex-1">
              <Label htmlFor="invite-email">{t("email")}</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("emailPlaceholder")}
              />
            </div>
            <Button type="submit" disabled={isPending}>
              <UserPlus className="size-4" />
              {isPending ? t("inviteSubmitting") : t("inviteSubmit")}
            </Button>
          </form>
          {error && (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {success && (
            <p className="mt-3 text-sm text-green-600" role="status">
              {success}
            </p>
          )}
        </CardContent>
      </Card>

      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              {t("pendingTitle")}{" "}
              <span className="text-muted-foreground font-normal">
                ({invitations.length})
              </span>
            </CardTitle>
            <CardDescription>{t("pendingDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y border-t">
              {invitations.map((inv) => (
                <li
                  key={inv.id}
                  className="flex items-center justify-between gap-4 px-6 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <Mail className="size-4 text-muted-foreground" />
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{inv.name}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        {inv.email}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <Clock className="size-3" />
                        {t("expiresAt", {
                          date: new Date(inv.expiresAt).toLocaleString(),
                        })}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRevoke(inv)}
                    disabled={isPending}
                    className="shrink-0"
                  >
                    {t("revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {t("listCardTitle")}{" "}
            <span className="text-muted-foreground font-normal">
              ({users.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y border-t">
            {users.map((u) => {
              const isYou = u.id === currentUserId;
              return (
                <li
                  key={u.id}
                  className="flex items-center justify-between gap-4 px-6 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="size-9 rounded-full bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
                      {getInitials(u.name || u.email)}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{u.name}</span>
                        {isYou && (
                          <span className="text-xs px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground shrink-0">
                            {tCommon("you")}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground truncate">
                        {u.email}
                      </div>
                    </div>
                  </div>
                  {!isYou && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onDelete(u)}
                      disabled={isPending}
                      aria-label={t("deleteAriaLabel")}
                      className="shrink-0"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
