"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createServer, updateServer } from "@/actions/servers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Server } from "@/lib/db/schema";

type Mode = { type: "create" } | { type: "edit"; server: Server };

export function ServerForm({ mode }: { mode: Mode }) {
  const t = useTranslations("serverForm");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.server : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (mode.type === "create") {
      const result = await createServer({
        name: name.trim(),
        host: host.trim(),
        username: username.trim(),
        password,
      });
      setLoading(false);
      if (!result.success) {
        setError(result.message);
        return;
      }
      router.push("/servers");
      router.refresh();
      return;
    }

    // Edit: only send password if user typed something.
    const data: { name: string; host: string; username: string; password?: string } = {
      name: name.trim(),
      host: host.trim(),
      username: username.trim(),
    };
    if (password.length > 0) data.password = password;

    const result = await updateServer(mode.server.id, data);
    setLoading(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    router.push("/servers");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="server-name">{t("name")}</Label>
        <Input
          id="server-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="server-host">{t("host")}</Label>
        <Input
          id="server-host"
          required
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="192.168.x.x"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="server-username">{t("username")}</Label>
        <Input
          id="server-username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="server-password">
          {mode.type === "edit" ? t("passwordEdit") : t("password")}
        </Label>
        <Input
          id="server-password"
          type="password"
          required={mode.type === "create"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder={
            mode.type === "edit" ? t("passwordEditPlaceholder") : undefined
          }
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push("/servers")}
          disabled={loading}
        >
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={loading}>
          {loading
            ? t("submitting")
            : mode.type === "edit"
              ? t("saveChanges")
              : t("create")}
        </Button>
      </div>
    </form>
  );
}
