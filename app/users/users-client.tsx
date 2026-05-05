"use client";

import { useState, useTransition } from "react";
import {
  deleteUser,
  inviteUser,
  revokeInvitation,
} from "@/actions/users";
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
import { useDialog } from "@/components/dialog-provider";
import { Trash2 } from "lucide-react";

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
        setSuccess(result.message ?? "Undangan terkirim");
        setName("");
        setEmail("");
      }
    });
  }

  async function onDelete(user: UserRow) {
    const ok = await dialog.confirm({
      title: "Hapus user",
      description: `Hapus ${user.name} (${user.email})? Tindakan ini tidak bisa dibatalkan.`,
      confirmText: "Hapus",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteUser(user.id);
      if (!result.success) {
        await dialog.alert({
          title: "Gagal",
          description: result.message,
        });
      }
    });
  }

  async function onRevoke(inv: InvitationRow) {
    const ok = await dialog.confirm({
      title: "Batalkan undangan",
      description: `Batalkan undangan untuk ${inv.email}?`,
      confirmText: "Batalkan",
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
          <CardTitle>Undang Pengguna</CardTitle>
          <CardDescription>
            Email harus berakhir dengan @example.com
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onInvite}
            className="flex flex-col gap-4 md:flex-row md:items-end"
          >
            <div className="flex flex-col gap-2 flex-1">
              <Label htmlFor="invite-name">Nama</Label>
              <Input
                id="invite-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nama lengkap"
              />
            </div>
            <div className="flex flex-col gap-2 flex-1">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Mengirim..." : "Undang"}
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
            <CardTitle>Undangan Tertunda</CardTitle>
            <CardDescription>
              Undangan yang belum diaktivasi user.
            </CardDescription>
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
                      Kadaluarsa {new Date(inv.expiresAt).toLocaleString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRevoke(inv)}
                    disabled={isPending}
                  >
                    Batalkan
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pengguna ({users.length})</CardTitle>
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
                        (Anda)
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {u.email}
                  </div>
                </div>
                {u.id !== currentUserId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(u)}
                    disabled={isPending}
                    aria-label="Hapus"
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
