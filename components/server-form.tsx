"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  createServer,
  testServerConnection,
  updateServer,
} from "@/actions/servers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { Server } from "@/lib/db/schema";

type Mode = { type: "create" } | { type: "edit"; server: Server };

type Props = {
  mode: Mode;
  /**
   * Optional callbacks to override default navigation behaviour. When provided,
   * the form skips `router.push("/servers")` so it can be embedded in a modal.
   */
  onSuccess?: (server: Server) => void;
  onCancel?: () => void;
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

export function ServerForm({ mode, onSuccess, onCancel }: Props) {
  const t = useTranslations("serverForm");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.server : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  // Any field change invalidates a previous test result.
  function withReset<F extends (...args: never[]) => void>(fn: F): F {
    return ((...args: Parameters<F>) => {
      setTestState({ kind: "idle" });
      fn(...args);
    }) as F;
  }

  async function onTest() {
    setTestState({ kind: "testing" });
    const payload: {
      host: string;
      username: string;
      password?: string;
      serverId?: string;
    } = {
      host: host.trim(),
      username: username.trim(),
    };
    if (password.length > 0) payload.password = password;
    if (mode.type === "edit") payload.serverId = mode.server.id;

    const result = await testServerConnection(payload);
    if (result.ok) {
      setTestState({ kind: "ok" });
    } else {
      setTestState({ kind: "fail", message: result.message });
    }
  }

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
      if (onSuccess) {
        onSuccess(result.data);
        return;
      }
      router.push("/servers");
      router.refresh();
      return;
    }

    const data: {
      name: string;
      host: string;
      username: string;
      password?: string;
    } = {
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

  function handleCancel() {
    if (onCancel) {
      onCancel();
      return;
    }
    router.push("/servers");
  }

  // Test button is enabled when host & username are filled, AND either a
  // password is typed or we're in edit mode (we can fall back to stored).
  const canTest =
    host.trim().length > 0 &&
    username.trim().length > 0 &&
    (password.length > 0 || mode.type === "edit") &&
    testState.kind !== "testing" &&
    !loading;

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
          onChange={withReset((e) => setHost(e.target.value))}
          placeholder="192.168.x.x"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="server-username">{t("username")}</Label>
        <Input
          id="server-username"
          required
          value={username}
          onChange={withReset((e) => setUsername(e.target.value))}
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
          onChange={withReset((e) => setPassword(e.target.value))}
          autoComplete="new-password"
          placeholder={
            mode.type === "edit" ? t("passwordEditPlaceholder") : undefined
          }
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={!canTest}
        >
          {testState.kind === "testing" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          {t("testConnection")}
        </Button>
        <TestStatus state={testState} t={t} />
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
          onClick={handleCancel}
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

function TestStatus({
  state,
  t,
}: {
  state: TestState;
  t: (key: string) => string;
}) {
  if (state.kind === "idle" || state.kind === "testing") return null;
  if (state.kind === "ok") {
    return (
      <span className="text-sm text-green-600 dark:text-green-500 inline-flex items-center gap-1">
        <CheckCircle2 className="size-4" />
        {t("testSuccess")}
      </span>
    );
  }
  return (
    <span className="text-sm text-destructive inline-flex items-center gap-1 break-all">
      <XCircle className="size-4 shrink-0" />
      <span>
        {t("testFailed")}: {state.message}
      </span>
    </span>
  );
}
