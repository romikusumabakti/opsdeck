"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { acceptInvitation } from "@/actions/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

export function AcceptInviteForm({
  token,
  email,
  name,
}: {
  token: string;
  email: string;
  name: string;
}) {
  const t = useTranslations("acceptInvite");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError(t("passwordMismatch"));
      return;
    }

    setLoading(true);

    const result = await acceptInvitation({ token, password });

    if (!result.success) {
      setLoading(false);
      setError(result.message);
      return;
    }

    const { error: signInErr } = await authClient.signIn.email({
      email,
      password,
    });

    setLoading(false);

    if (signInErr) {
      router.push("/sign-in");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>{t("name")}</Label>
        <Input value={name} disabled />
      </div>
      <div className="flex flex-col gap-2">
        <Label>{t("email")}</Label>
        <Input value={email} disabled />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("newPassword")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">{t("confirmPassword")}</Label>
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
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={loading}>
        {loading ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
