"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Aperture, CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Separator } from "@/components/ui/separator";
import { Link, useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

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
    case "email_doesn't_match":
    case "account_already_linked_to_different_user":
      return "errorMicrosoftNotLinked" as const;
    case "email_not_found":
      return "errorMicrosoftNoEmail" as const;
    default:
      return "errorMicrosoft" as const;
  }
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
  const tApp = useTranslations("app");
  const router = useRouter();
  const [microsoftPending, setMicrosoftPending] = useState(false);

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
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    setSubmitError(null);
    const { error } = await authClient.signIn.email(values);

    if (error) {
      setSubmitError(error.message ?? t("errorInvalid"));
      return;
    }

    router.push(redirectTo || "/");
    router.refresh();
  }

  async function onMicrosoftSignIn() {
    setSubmitError(null);
    setMicrosoftPending(true);

    // Both URLs are plain browser redirects handled outside the i18n router,
    // so they carry no locale prefix — the proxy re-adds the user's locale.
    const { error } = await authClient.signIn.social({
      provider: "microsoft",
      callbackURL: redirectTo || "/",
      errorCallbackURL: "/sign-in",
    });

    // On success the browser navigates away, so only the failure path needs to
    // clear the pending flag.
    if (error) {
      setSubmitError(error.message ?? t("errorMicrosoft"));
      setMicrosoftPending(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="flex items-center gap-2 mb-2">
          <Aperture />
          <span className="font-bold">{tApp("name")}</span>
        </div>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            {submitError && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("email")}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder={t("emailPlaceholder")}
                      {...field}
                      onChange={(e) => {
                        setSubmitError(null);
                        field.onChange(e);
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>{t("password")}</FormLabel>
                    <Link
                      href="/forgot-password"
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      {t("forgotPassword")}
                    </Link>
                  </div>
                  <FormControl>
                    <PasswordInput
                      autoComplete="current-password"
                      {...field}
                      onChange={(e) => {
                        setSubmitError(null);
                        field.onChange(e);
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={form.formState.isSubmitting || microsoftPending}
            >
              {form.formState.isSubmitting ? t("submitting") : t("submit")}
            </Button>
          </form>
        </Form>

        {microsoftEnabled && (
          <>
            <div className="flex items-center gap-3 my-4">
              <Separator className="flex-1" />
              <span className="text-xs uppercase text-muted-foreground">
                {t("or")}
              </span>
              <Separator className="flex-1" />
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={onMicrosoftSignIn}
              disabled={microsoftPending || form.formState.isSubmitting}
            >
              <MicrosoftLogo className="size-4" />
              {microsoftPending
                ? t("microsoftSubmitting")
                : t("microsoftSubmit")}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
