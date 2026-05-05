"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revokeOther, setRevokeOther] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword !== confirm) {
      setError("Konfirmasi password tidak cocok");
      return;
    }

    setLoading(true);
    const { error: err } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: revokeOther,
    });
    setLoading(false);

    if (err) {
      setError(err.message ?? "Gagal mengubah password");
      return;
    }

    setSuccess("Password berhasil diubah");
    setCurrentPassword("");
    setNewPassword("");
    setConfirm("");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="current">Password lama</Label>
        <Input
          id="current"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new">Password baru</Label>
        <Input
          id="new"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">Konfirmasi password baru</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={revokeOther}
          onChange={(e) => setRevokeOther(e.target.checked)}
        />
        Keluarkan saya dari semua perangkat lain
      </label>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="text-sm text-green-600" role="status">
          {success}
        </p>
      )}
      <Button type="submit" disabled={loading} className="self-start">
        {loading ? "Memproses..." : "Ubah Password"}
      </Button>
    </form>
  );
}
