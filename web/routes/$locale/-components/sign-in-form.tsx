import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, Fingerprint, Loader2 } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useLocale, useTranslations } from "use-intl";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Separator } from "@/components/ui/separator";
import type { Locale } from "@/i18n/locales";
import { Link, localizeHref, useRouter } from "@/i18n/navigation";
import {
  authClient,
  isPasskeyAutofillSupported,
  isPasskeySupported,
} from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { resetSession } from "@/web/api/session";

/**
 * The password form is mounted, not unhidden, so it would otherwise appear in
 * a single frame when the disclosure is used. Short enough to read as the card
 * growing rather than as a transition the user has to wait out.
 */
const revealAnimation =
  "animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none";

/**
 * Microsoft's brand mark. Lucide ships no vendor logos, and the guidelines
 * require the four-square glyph next to the "Sign in with Microsoft" label.
 */
function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

/**
 * Map the error codes better-auth appends to `errorCallbackURL` onto our own
 * message keys. Anything unrecognised falls back to a generic message so a raw
 * slug never reaches the user.
 */
function oauthErrorKey(code: string) {
  switch (code) {
    case "domain_not_allowed":
      return "errorMicrosoftDomain" as const;
    case "signup_disabled":
      return "errorMicrosoftNoAccount" as const;
    case "account_not_linked":
    case "unable_to_link_account":
    case "email_does_not_match":
    case "account_already_linked_to_different_user":
      return "errorMicrosoftNotLinked" as const;
    case "email_not_found":
      return "errorMicrosoftNoEmail" as const;
    default:
      return "errorMicrosoft" as const;
  }
}

/**
 * Codes a passkey ceremony reports when the user simply walked away — they
 * dismissed the browser sheet, or it was aborted because another ceremony
 * started. There is nothing to tell them, so these never surface as an error.
 */
const PASSKEY_CANCELLED_CODES = new Set([
  "AUTH_CANCELLED",
  "ERROR_CEREMONY_ABORTED",
]);

/** better-auth codes meaning the pending two-factor challenge can no longer be answered. */
const CHALLENGE_ENDED_CODES = new Set([
  "INVALID_TWO_FACTOR_COOKIE",
  "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
]);

/**
 * The second step of a password sign-in: an authenticator code, or a backup
 * code when the phone is gone. Never asks the server to trust the device, so
 * the next sign-in asks again.
 */
function TwoFactorStep({
  onVerified,
  onCancel,
  onExpired,
}: {
  onVerified: () => Promise<void>;
  onCancel: () => void;
  onExpired: () => void;
}) {
  const t = useTranslations("signIn");
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    if (!value) return;
    setError(null);
    setPending(true);
    const { error: failure } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: value })
      : await authClient.twoFactor.verifyTotp({ code: value });
    if (failure) {
      // The challenge is gone (its cookie expired, or the attempt limit used
      // it up), so no code can work any more: start over from the password.
      if (CHALLENGE_ENDED_CODES.has(failure.code ?? "")) {
        onExpired();
        return;
      }
      setPending(false);
      setError(failure.message ?? t("errorCode"));
      return;
    }
    await onVerified();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div aria-live="polite" aria-atomic="true" className="empty:hidden">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {useBackup ? t("backupCodeHint") : t("codeHint")}
      </p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="sign-in-code">
            {useBackup ? t("backupCode") : t("code")}
          </FieldLabel>
          <Input
            id="sign-in-code"
            key={useBackup ? "backup" : "totp"}
            value={code}
            onChange={(e) => {
              setError(null);
              setCode(e.target.value);
            }}
            autoComplete="one-time-code"
            inputMode={useBackup ? "text" : "numeric"}
            maxLength={useBackup ? undefined : 6}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
          {t("verify")}
        </Button>
      </FieldGroup>
      <Button
        type="button"
        variant="ghost"
        className="w-full text-muted-foreground hover:text-foreground"
        onClick={() => {
          setUseBackup((v) => !v);
          setCode("");
          setError(null);
        }}
        disabled={pending}
      >
        {useBackup ? t("useAuthenticator") : t("useBackupCode")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full text-muted-foreground hover:text-foreground"
        onClick={onCancel}
        disabled={pending}
      >
        {t("backToSignIn")}
      </Button>
    </form>
  );
}

export function SignInForm({
  redirectTo,
  microsoftEnabled,
  oauthError,
}: {
  redirectTo?: string;
  microsoftEnabled?: boolean;
  oauthError?: string;
}) {
  const t = useTranslations("signIn");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [microsoftPending, setMicrosoftPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);

  // Set once the password was accepted but the account needs a second factor.
  // The session does not exist yet at that point, only a pending-verification
  // cookie, so the code step replaces the whole form.
  const [needsCode, setNeedsCode] = useState(false);

  // Whether this browser does WebAuthn at all.
  const [passkeySupported] = useState(isPasskeySupported);

  // One conditional ceremony per page load. Guards against React's development
  // double-invoke of effects starting a second one that aborts the first.
  const autofillStarted = useRef(false);

  // Microsoft is the primary route for a single-domain internal panel, so the
  // password form starts collapsed behind a link. It is expanded up-front when
  // there is nothing to collapse behind, and when the user has just bounced
  // back from a failed OAuth round trip — at that point the password path is
  // the fallback they need.
  const [emailExpanded, setEmailExpanded] = useState(
    !microsoftEnabled || Boolean(oauthError)
  );

  // Only the disclosure moves focus into the form. Autofocusing on first paint
  // would pop the on-screen keyboard on mobile and drop a screen reader past
  // the heading — and on the default view Microsoft, not the password field,
  // is the route we want the user looking at.
  const [focusEmail, setFocusEmail] = useState(false);

  // better-auth bounces failed OAuth callbacks back here with `?error=<code>`,
  // so the initial error can come from the URL rather than a form submit.
  const [submitError, setSubmitError] = useState<string | null>(
    oauthError ? t(oauthErrorKey(oauthError)) : null
  );

  const tCommon = useTranslations("common");

  const schema = z.object({
    email: z.string().email(tCommon("emailInvalid")),
    password: z.string().min(1, tCommon("required")),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
    // Validate a field once the user has left it, then keep it live while they
    // correct it — the error shows up next to the field being worked on rather
    // than all at once on submit.
    mode: "onTouched",
    reValidateMode: "onChange",
  });

  const busy =
    form.formState.isSubmitting || microsoftPending || passkeyPending;

  // Signed in: load the new session (dropping anything cached while signed
  // out) so the gate lets the target page through, then go there.
  const enterApp = useCallback(async () => {
    await resetSession();
    router.push(redirectTo || "/");
  }, [redirectTo, router]);

  // Conditional UI ("passkey autofill"): the browser offers this site's
  // passkeys from the email field's own autofill dropdown, so a returning user
  // signs in without touching the password. The ceremony must be started while
  // that field is on screen, hence the dependency on the disclosure state. It
  // settles only when the user picks a passkey — or never, if they type a
  // password instead — so every failure here is silent by design.
  useEffect(() => {
    if (!emailExpanded || autofillStarted.current) return;
    let cancelled = false;
    (async () => {
      if (!(await isPasskeyAutofillSupported()) || cancelled) return;
      autofillStarted.current = true;
      const { error } = await authClient.signIn.passkey({ autoFill: true });
      if (cancelled || error) return;
      await enterApp();
    })();
    return () => {
      cancelled = true;
    };
  }, [emailExpanded, enterApp]);

  async function onSubmit(values: z.infer<typeof schema>) {
    setSubmitError(null);
    const { data, error } = await authClient.signIn.email(values);

    if (error) {
      setSubmitError(error.message ?? t("errorInvalid"));
      return;
    }

    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setNeedsCode(true);
      return;
    }

    await enterApp();
  }

  async function onPasskeySignIn() {
    setSubmitError(null);
    setPasskeyPending(true);

    // Starting this ceremony aborts the conditional one waiting on the email
    // field — @simplewebauthn cancels any in-flight request before opening a
    // new one — so the two entry points cannot collide.
    const { error } = await authClient.signIn.passkey();
    setPasskeyPending(false);

    if (!error) {
      await enterApp();
      return;
    }

    // `error.message` from the server is not localised, so map the one code
    // worth explaining and fall back to a generic line for the rest.
    const code = "code" in error ? error.code : undefined;
    if (code && PASSKEY_CANCELLED_CODES.has(code)) return;
    setSubmitError(
      code === "PASSKEY_NOT_FOUND"
        ? t("errorPasskeyNotFound")
        : t("errorPasskey")
    );
  }

  async function onMicrosoftSignIn() {
    setSubmitError(null);
    setMicrosoftPending(true);

    // Both URLs are plain browser redirects that load the app afresh, so
    // they carry the locale the user is reading in.
    const { error } = await authClient.signIn.social({
      provider: "microsoft",
      callbackURL: localizeHref(redirectTo || "/", locale),
      errorCallbackURL: localizeHref("/sign-in", locale),
    });

    // On success the browser navigates away, so only the failure path needs to
    // clear the pending flag.
    if (error) {
      setSubmitError(error.message ?? t("errorMicrosoft"));
      setMicrosoftPending(false);
    }
  }

  if (needsCode) {
    return (
      <TwoFactorStep
        onVerified={enterApp}
        onCancel={() => {
          setNeedsCode(false);
          form.resetField("password");
        }}
        onExpired={() => {
          setNeedsCode(false);
          form.resetField("password");
          setSubmitError(t("errorCodeExpired"));
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Always mounted so a screen reader announces errors that appear after
          the initial render instead of only those present at mount. */}
      <div aria-live="polite" aria-atomic="true" className="empty:hidden">
        {submitError && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}
      </div>

      {microsoftEnabled && (
        <Button
          type="button"
          variant="outline"
          // Microsoft's guidelines pin their own asset at 41px tall with a
          // #8C8C8C border; those numbers come from the raster button and they
          // allow a host-styled equivalent, so this follows our own control
          // height and border token instead of sitting 5px taller than the
          // submit button below it.
          className="w-full"
          onClick={onMicrosoftSignIn}
          disabled={busy}
          aria-busy={microsoftPending}
        >
          {microsoftPending ? (
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            <MicrosoftLogo className="size-5" />
          )}
          {t("microsoftSubmit")}
          {microsoftPending && (
            <span className="sr-only">{t("microsoftSubmitting")}</span>
          )}
        </Button>
      )}

      {passkeySupported && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={onPasskeySignIn}
          disabled={busy}
          aria-busy={passkeyPending}
        >
          {passkeyPending ? (
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            <Fingerprint className="size-5" aria-hidden="true" />
          )}
          {t("passkeySubmit")}
          {passkeyPending && (
            <span className="sr-only">{t("passkeySubmitting")}</span>
          )}
        </Button>
      )}

      {(microsoftEnabled || passkeySupported) && emailExpanded && (
        <div className={cn("flex items-center gap-3", revealAnimation)}>
          <Separator className="flex-1" />
          <span className="text-xs uppercase text-muted-foreground">
            {t("or")}
          </span>
          <Separator className="flex-1" />
        </div>
      )}

      {emailExpanded ? (
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className={revealAnimation}
        >
          <FieldGroup>
            <Controller
              name="email"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="sign-in-email">{t("email")}</FieldLabel>
                  <Input
                    type="email"
                    inputMode="email"
                    // The `webauthn` token is what lets the browser list this
                    // site's passkeys in the field's autofill dropdown; the
                    // effect above starts the ceremony that fills it.
                    autoComplete="email webauthn"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    // Set only when the disclosure revealed the form, so the
                    // keyboard path is uninterrupted there without hijacking
                    // focus on a normal page load.
                    autoFocus={focusEmail}
                    placeholder={t("emailPlaceholder")}
                    {...field}
                    id="sign-in-email"
                    aria-invalid={fieldState.invalid}
                    onChange={(e) => {
                      setSubmitError(null);
                      field.onChange(e);
                    }}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="password"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <div className="flex items-center justify-between">
                    <FieldLabel htmlFor="sign-in-password">
                      {t("password")}
                    </FieldLabel>
                    <Link
                      href="/forgot-password"
                      className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {t("forgotPassword")}
                    </Link>
                  </div>
                  <PasswordInput
                    autoComplete="current-password"
                    {...field}
                    id="sign-in-password"
                    aria-invalid={fieldState.invalid}
                    onChange={(e) => {
                      setSubmitError(null);
                      field.onChange(e);
                    }}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Button
              type="submit"
              disabled={busy}
              aria-busy={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting && (
                <Loader2 className="animate-spin" aria-hidden="true" />
              )}
              {t("submit")}
              {form.formState.isSubmitting && (
                <span className="sr-only">{t("submitting")}</span>
              )}
            </Button>
          </FieldGroup>
        </form>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground hover:text-foreground"
          onClick={() => {
            setFocusEmail(true);
            setEmailExpanded(true);
          }}
          disabled={busy}
        >
          {t("emailInstead")}
        </Button>
      )}
    </div>
  );
}
