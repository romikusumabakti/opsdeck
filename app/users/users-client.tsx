"use client";

import { Trash2 } from "lucide-react";
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
      confirmText: t("deleteConfirm"),
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
            <CardTitle>{t("pendingTitle")}</CardTitle>
            <CardDescription>{t("pendingDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {invitations.map((inv) => (
                <li
                  key={inv.id}
                  className="py-3 flex items-center justify-between gap-4"
                >
                  <div>
                    <div className="font-medium">{inv.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {inv.email}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {t("expiresAt", {
                        date: new Date(inv.expiresAt).toLocaleString(),
                      })}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRevoke(inv)}
                    disabled={isPending}
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
          <CardTitle>{t("listTitle", { count: users.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {users.map((u) => (
              <li
                key={u.id}
                className="py-3 flex items-center justify-between gap-4"
              >
                <div>
                  <div className="font-medium">
                    {u.name}
                    {u.id === currentUserId && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({tCommon("you")})
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">{u.email}</div>
                </div>
                {u.id !== currentUserId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(u)}
                    disabled={isPending}
                    aria-label={t("deleteAriaLabel")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
