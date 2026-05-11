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
import { useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

export function SignInForm({ redirectTo }: { redirectTo?: string }) {
  const t = useTranslations("signIn");
  const tApp = useTranslations("app");
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);

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
                  <FormLabel>{t("password")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
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
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? t("submitting") : t("submit")}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
