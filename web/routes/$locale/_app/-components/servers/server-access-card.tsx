import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { CopyButton } from "@/components/copy-button";
import { useDialog } from "@/components/dialog-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useKeyErrorMessage } from "@/hooks/use-key-error-message";
import { ApiError } from "@/web/api/client";
import {
  checkServerKeyLogin,
  getServerAuthorizedLineQuery,
  moveServerToKey,
  reinstallServerKey,
  type ServerRow,
  trustServerHostKey,
} from "@/web/api/servers";
import { accessState } from "./access-state";

// How long the from= field must rest before its command is fetched.
const FROM_DEBOUNCE_MS = 400;

/**
 * Shows a refused key action's message (translated by the server from its
 * stable code); rethrows a 401, where sign-in is already underway.
 */
function reportError(error: unknown): void {
  if (error instanceof ApiError && error.status !== 401) {
    toast.error(error.message);
    return;
  }
  throw error;
}

/**
 * The server page's SSH access: how the Panel signs in, the pinned host key
 * and the from= address, with Move to SSH key or Reinstall key, and a banner
 * when the server offered another host key. A key server also has its install
 * command and Check key login, so one installed by hand that never signed in
 * (or whose from= changed) is never a dead end. Actions need server:manage.
 */
export function ServerAccessCard({
  server,
  canManage,
}: {
  server: ServerRow;
  canManage: boolean;
}) {
  const t = useTranslations("serverAccess");
  const format = useFormatter();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const keyErrorMessage = useKeyErrorMessage();
  const [busy, setBusy] = useState(false);
  const [askPassword, setAskPassword] = useState(false);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
    }
  }

  async function onMove() {
    // Without a stored password, the move needs one typed once.
    if (!server.hasPassword) {
      setAskPassword(true);
      return;
    }
    await run(() => moveServerToKey(server.id), t("moveToKeyDone"));
  }

  async function onTrust(fingerprint: string) {
    const ok = await dialog.confirm({
      title: t("trustTitle"),
      description: t("trustDescription", { fingerprint }),
      confirmText: t("trustNewKey"),
    });
    if (!ok) return;
    // The fingerprint shown is the one trusted: if the server has offered
    // another since, the Panel refuses (hostKeyChanged).
    await run(() => trustServerHostKey(server.id, fingerprint), t("trustDone"));
  }

  const state = accessState(server);
  const pinnedAt = server.hostKeyPinnedAt
    ? format.dateTime(new Date(server.hostKeyPinnedAt), {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-5 text-muted-foreground" />
          <CardTitle className="text-base">{t("title")}</CardTitle>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {server.hostKeyMismatch && server.offeredFingerprint ? (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>{t("mismatchTitle")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <p>{t("mismatchDescription")}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt>{t("pinnedFingerprint")}</dt>
                <dd className="font-mono text-xs break-all">
                  {server.hostKeyFingerprint ?? "—"}
                </dd>
                <dt>{t("offeredFingerprint")}</dt>
                <dd className="font-mono text-xs break-all">
                  {server.offeredFingerprint}
                </dd>
              </dl>
              {canManage ? (
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-fit"
                  disabled={busy}
                  onClick={() => {
                    if (server.offeredFingerprint) {
                      void onTrust(server.offeredFingerprint);
                    }
                  }}
                >
                  {t("trustNewKey")}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("signIn")}</dt>
          <dd>
            <Badge variant={state === "key" ? "secondary" : "outline"}>
              {state === "keyNotVerified"
                ? t("keyNotVerified")
                : state === "needsSetup"
                  ? t("needsSetup")
                  : server.auth === "key"
                    ? t("key")
                    : t("password")}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">{t("hostKey")}</dt>
          <dd className="flex flex-col gap-0.5">
            {server.hostKeyFingerprint ? (
              <>
                <span className="font-mono text-xs break-all">
                  {server.hostKeyFingerprint}
                </span>
                {pinnedAt ? (
                  <span className="text-xs text-muted-foreground">
                    {t("pinnedAt", { date: pinnedAt })}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">{t("notPinned")}</span>
            )}
          </dd>
          {server.auth === "key" && server.sshFrom ? (
            <>
              <dt className="text-muted-foreground">{t("from")}</dt>
              <dd className="font-mono text-xs">{server.sshFrom}</dd>
            </>
          ) : null}
          {server.keyError && state !== "keyNotVerified" ? (
            <>
              <dt className="text-muted-foreground">{t("lastError")}</dt>
              <dd className="text-destructive">
                {keyErrorMessage(server.keyError)}
              </dd>
            </>
          ) : null}
        </dl>

        {canManage && server.auth === "key" ? (
          // Open at once while the key never signed in: right after a server
          // is added this way, its command (for the saved row) is the next step.
          <AdvancedOptions
            label={t("showInstallCommand")}
            defaultOpen={state === "keyNotVerified"}
          >
            <KeyInstallCheck server={server} />
          </AdvancedOptions>
        ) : null}

        {canManage ? (
          <div>
            {server.auth === "password" ? (
              <Button variant="outline" disabled={busy} onClick={onMove}>
                {busy ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : null}
                {t("moveToKey")}
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setAskPassword(true)}
              >
                {t("reinstallKey")}
              </Button>
            )}
          </div>
        ) : null}
      </CardContent>

      <PasswordOnceDialog
        open={askPassword}
        onOpenChange={setAskPassword}
        title={server.auth === "key" ? t("reinstallKey") : t("moveToKey")}
        username={server.username}
        onSubmit={async (password) => {
          const ok = await run(
            () => reinstallServerKey(server.id, password),
            t("moveToKeyDone")
          );
          if (ok) setAskPassword(false);
        }}
      />
    </Card>
  );
}

/**
 * Asks for the login's password to install the key with. The password lives
 * only in this dialog's state and the one request; the Panel never stores it.
 */
function PasswordOnceDialog({
  open,
  onOpenChange,
  title,
  username,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  username: string;
  onSubmit: (password: string) => Promise<void>;
}) {
  const t = useTranslations("serverAccess");
  const tCommon = useTranslations("common");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function close(next: boolean) {
    if (!next) setPassword("");
    onOpenChange(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!password) return;
    setSubmitting(true);
    try {
      await onSubmit(password);
    } finally {
      setSubmitting(false);
      setPassword("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {t("passwordOnceDescription", { username })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="server-key-password">{t("passwordLabel")}</Label>
            <PasswordInput
              id="server-key-password"
              autoComplete="off"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => close(false)}
              disabled={submitting}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !password}>
              {submitting ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              {t("install")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A key server's install command for its own key, with an editable from=
 * (prefilled from the row), and Check key login: a key-only sign-in that, on
 * success, marks the key verified and saves the from= its line on the host
 * carries (the field only shapes the command).
 */
function KeyInstallCheck({ server }: { server: ServerRow }) {
  const t = useTranslations("serverAccess");
  const tForm = useTranslations("serverForm");
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(server.sshFrom ?? "");
  const [checking, setChecking] = useState(false);
  const typed = from.trim();
  const settled = useDebouncedValue(typed, FROM_DEBOUNCE_MS);
  // Only the command for the address in the field is ever shown.
  const current = settled === typed && typed.length > 0;
  const line = useQuery({
    ...getServerAuthorizedLineQuery(server.id, settled),
    enabled: current,
  });

  async function check() {
    setChecking(true);
    try {
      await checkServerKeyLogin(server.id);
      toast.success(t("checkKeyLoginDone"));
    } catch (error) {
      reportError(error);
    } finally {
      setChecking(false);
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="server-ssh-from">{tForm("sshFrom")}</Label>
        <Input
          id="server-ssh-from"
          name="sshFrom"
          autoComplete="off"
          placeholder={tForm("sshFromPlaceholder")}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          {tForm("sshFromDescription")}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{tForm("installCommand")}</span>
        {typed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {tForm("installCommandEmpty")}
          </p>
        ) : current && line.isError ? (
          <p className="text-sm text-destructive">
            {line.error instanceof ApiError
              ? line.error.message
              : String(line.error)}
          </p>
        ) : current && line.data ? (
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-background p-2 font-mono text-xs">
              {line.data.command}
            </code>
            <CopyButton value={line.data.command} />
          </div>
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
      <Button
        variant="outline"
        className="w-fit"
        disabled={checking}
        onClick={() => void check()}
      >
        {checking ? (
          <Loader2 data-icon="inline-start" className="animate-spin" />
        ) : null}
        {t("checkKeyLogin")}
      </Button>
    </div>
  );
}
