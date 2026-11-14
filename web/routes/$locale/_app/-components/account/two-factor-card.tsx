import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { authClient, useSession } from "@/lib/auth-client";

type PasswordAction = "enable" | "disable" | "regenerate";

/** Pending enrolment: the secret is shown, but not active until a code is verified. */
interface Setup {
  uri: string;
  secret: string;
  backupCodes: string[];
}

/** The secret is the `secret` query parameter of the `otpauth://` URI. */
function secretFromUri(uri: string) {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function TwoFactorCard({ hasPassword }: { hasPassword: boolean }) {
  const t = useTranslations("account.twoFactor");
  const tCommon = useTranslations("common");
  const { data: session } = useSession();
  const enabled = session?.user.twoFactorEnabled === true;

  const [action, setAction] = useState<PasswordAction | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  // Backup codes are only ever shown right after they are made.
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startAction(next: PasswordAction) {
    setAction(next);
    setPassword("");
    setError(null);
  }

  function cancel() {
    setAction(null);
    setSetup(null);
    setPassword("");
    setCode("");
    setError(null);
  }

  async function onSubmitPassword(event: FormEvent) {
    event.preventDefault();
    if (!action || !password) return;
    setError(null);
    setPending(true);
    try {
      if (action === "enable") {
        const { data, error: failure } = await authClient.twoFactor.enable({
          password,
          method: "totp",
        });
        if (failure || data?.method !== "totp") {
          setError(failure?.message ?? tCommon("errorGeneric"));
          return;
        }
        setSetup({
          uri: data.totpURI,
          secret: secretFromUri(data.totpURI),
          backupCodes: data.backupCodes,
        });
        setAction(null);
      } else if (action === "disable") {
        const { error: failure } = await authClient.twoFactor.disable({
          password,
        });
        if (failure) {
          setError(failure.message ?? tCommon("errorGeneric"));
          return;
        }
        toast.success(t("disabledSuccess"));
        setAction(null);
      } else {
        const { data, error: failure } =
          await authClient.twoFactor.generateBackupCodes({ password });
        if (failure || !data) {
          setError(failure?.message ?? tCommon("errorGeneric"));
          return;
        }
        setBackupCodes(data.backupCodes);
        setAction(null);
      }
      setPassword("");
    } finally {
      setPending(false);
    }
  }

  async function onVerify(event: FormEvent) {
    event.preventDefault();
    if (!setup || !code.trim()) return;
    setError(null);
    setPending(true);
    const { error: failure } = await authClient.twoFactor.verifyTotp({
      code: code.trim(),
    });
    setPending(false);
    if (failure) {
      setError(failure.message ?? t("errorCode"));
      return;
    }
    toast.success(t("enabledSuccess"));
    setBackupCodes(setup.backupCodes);
    setSetup(null);
    setCode("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("title")}
          {enabled && <Badge variant="secondary">{t("on")}</Badge>}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {backupCodes ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t("backupCodesHint")}
            </p>
            <ul
              className="grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm"
              data-testid="backup-codes"
            >
              {backupCodes.map((backupCode) => (
                <li key={backupCode}>{backupCode}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <CopyButton
                variant="outline"
                value={backupCodes.join("\n")}
                label={t("copyBackupCodes")}
              />
              <Button type="button" onClick={() => setBackupCodes(null)}>
                {t("done")}
              </Button>
            </div>
          </div>
        ) : setup ? (
          <form onSubmit={onVerify} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("scanHint")}</p>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              {/* White tile so the code stays scannable in dark mode. */}
              <div className="rounded-md bg-white p-3">
                <QRCodeSVG value={setup.uri} size={152} />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t("secretLabel")}
                </span>
                <div className="flex items-center gap-1">
                  <code
                    className="break-all font-mono text-sm"
                    data-testid="totp-secret"
                  >
                    {setup.secret}
                  </code>
                  <CopyButton value={setup.secret} label={t("copySecret")} />
                </div>
              </div>
            </div>
            <FieldGroup>
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="two-factor-code">{t("code")}</FieldLabel>
                <Input
                  id="two-factor-code"
                  value={code}
                  onChange={(e) => {
                    setError(null);
                    setCode(e.target.value);
                  }}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  aria-invalid={error ? true : undefined}
                />
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={pending} aria-busy={pending}>
                  {pending && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  {t("verify")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={cancel}
                  disabled={pending}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            </FieldGroup>
          </form>
        ) : action ? (
          <form onSubmit={onSubmitPassword}>
            <FieldGroup>
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="two-factor-password">
                  {t("passwordLabel")}
                </FieldLabel>
                <PasswordInput
                  id="two-factor-password"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => {
                    setError(null);
                    setPassword(e.target.value);
                  }}
                  aria-invalid={error ? true : undefined}
                />
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </Field>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant={action === "disable" ? "destructive" : "default"}
                  disabled={pending || !password}
                  aria-busy={pending}
                >
                  {pending && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  {t(`${action}Confirm`)}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={cancel}
                  disabled={pending}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            </FieldGroup>
          </form>
        ) : enabled ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden="true" />
              {t("onDescription")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => startAction("regenerate")}
              >
                {t("regenerate")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => startAction("disable")}
              >
                {t("turnOff")}
              </Button>
            </div>
          </div>
        ) : !hasPassword ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t("noPassword")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldOff className="size-4" aria-hidden="true" />
              {t("offDescription")}
            </p>
            <div>
              <Button type="button" onClick={() => startAction("enable")}>
                {t("turnOn")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
