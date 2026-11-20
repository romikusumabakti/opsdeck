import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { AccentDot } from "@/components/accent-dot";
import type { BrandLogoSource } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { ACCENTS, type AccentColor, isAccent } from "@/lib/accents";
import { DEFAULT_APP_NAME } from "@/lib/brand-logos";
import { cn } from "@/lib/utils";
import { ApiError } from "@/web/api/client";
import {
  type BrandingData,
  type BrandTheme,
  getBrandingQuery,
  removeBrandLogo,
  saveBranding,
  uploadBrandLogo,
} from "@/web/api/instance";
import { bootstrapQuery, useMe } from "@/web/api/session";
import { applyDocumentAccent } from "@/web/document-locale";
import { BrandPreview } from "./brand-preview";
import { reportError } from "./report-error";

// Every refusal of a logo upload (lib/brand-logo-validate, the branding
// service and route); anything else reads as `failed`.
const LOGO_ERRORS = [
  "too_large",
  "unsupported_type",
  "invalid_image",
  "not_square",
  "too_small",
  "too_large_dimensions",
  "light_logo_required",
  "no_file",
] as const;
type LogoErrorCode = (typeof LOGO_ERRORS)[number] | "failed";

const LOGO_ACCEPT = "image/svg+xml,image/png,image/webp";

/** The accent choices: the stored null ("default", neutral) and each colour. */
type AccentChoice = "default" | Exclude<AccentColor, "neutral">;
const ACCENT_CHOICES: AccentChoice[] = [
  "default",
  ...ACCENTS.filter(
    (a): a is Exclude<AccentColor, "neutral"> => a !== "neutral"
  ),
];

const choiceOf = (accent: AccentColor | null): AccentChoice =>
  accent && accent !== "neutral" ? accent : "default";
const accentOf = (choice: string): AccentColor | null =>
  choice !== "default" && isAccent(choice) ? choice : null;

type Values = { name: string; company: string; accent: AccentChoice };

const valuesOf = (data: BrandingData): Values => ({
  name: data.name ?? "",
  company: data.company ?? "",
  accent: choiceOf(data.accent),
});

function logoErrorCode(error: unknown): LogoErrorCode {
  const code =
    error instanceof ApiError ? (error.code ?? error.message) : undefined;
  return (LOGO_ERRORS as readonly string[]).includes(code ?? "")
    ? (code as LogoErrorCode)
    : "failed";
}

/**
 * Admin → Instance → Branding: the instance name, company and default
 * accent (saved together), the logo and its dark-mode variant (each uploaded
 * or removed at once), and a live preview of both. After any write the
 * bootstrap and the router reload, so the shell, the messages' {{APP_NAME}}
 * and the favicon show the change without a page load.
 */
export function BrandingTab() {
  const t = useTranslations("instance.branding");
  const tCommon = useTranslations("common");
  const tAccent = useTranslations("accentSwitcher");
  const queryClient = useQueryClient();
  const router = useRouter();
  const me = useMe();
  const data = useSuspenseQuery(getBrandingQuery()).data;

  const form = useForm<Values>({ defaultValues: valuesOf(data) });
  const saving = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !saving);

  /**
   * After a write that succeeded: shows it everywhere. A refresh that fails
   * says so on its own; the write itself stands.
   */
  async function refreshAfterWrite(saved: BrandingData) {
    queryClient.setQueryData(getBrandingQuery().queryKey, saved);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: bootstrapQuery().queryKey }),
        queryClient.invalidateQueries(getBrandingQuery()),
      ]);
      // The $locale loader brands the messages with the instance name.
      await router.invalidate();
    } catch (error) {
      // A 401 is already sending the user to sign in.
      if (!(error instanceof ApiError && error.status === 401)) {
        toast.error(t("refreshFailed"));
      }
      return;
    }
    // Without an accent of their own the admin wears the instance's.
    if (me && !me.user.accentColor) {
      const bootstrap = queryClient.getQueryData(bootstrapQuery().queryKey);
      if (bootstrap) {
        applyDocumentAccent(saved.accent ?? "neutral", bootstrap.icon);
      }
    }
  }

  async function onSubmit(values: Values) {
    let saved: BrandingData;
    try {
      saved = await saveBranding({
        name: values.name.trim() || null,
        company: values.company.trim() || null,
        accent: accentOf(values.accent),
      });
    } catch (error) {
      reportError(error);
      return;
    }
    form.reset(valuesOf(saved));
    toast.success(t("saved"));
    await refreshAfterWrite(saved);
  }

  const watched = form.watch();
  const logo: BrandLogoSource = data.logo
    ? { src: data.logo.src, darkSrc: data.logoDark?.src ?? null }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("preview")}</CardTitle>
          <CardDescription>{t("previewDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <BrandPreview
            name={watched.name.trim() || DEFAULT_APP_NAME}
            accent={accentOf(watched.accent) ?? "neutral"}
            logo={logo}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex max-w-2xl flex-col gap-4"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="brand-name">{t("name")}</FieldLabel>
                <Input
                  id="brand-name"
                  placeholder={DEFAULT_APP_NAME}
                  maxLength={60}
                  autoComplete="off"
                  {...form.register("name")}
                />
                <FieldDescription>{t("nameRestartHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="brand-company">{t("company")}</FieldLabel>
                <Input
                  id="brand-company"
                  maxLength={120}
                  autoComplete="organization"
                  {...form.register("company")}
                />
                <FieldDescription>{t("companyDescription")}</FieldDescription>
              </Field>
              <Controller
                name="accent"
                control={form.control}
                render={({ field }) => (
                  <Field>
                    <FieldLabel>{t("accent")}</FieldLabel>
                    <RadioGroup
                      aria-label={t("accent")}
                      className="flex flex-wrap gap-x-4 gap-y-3"
                      value={field.value}
                      onValueChange={(value) =>
                        field.onChange(value as AccentChoice)
                      }
                    >
                      {ACCENT_CHOICES.map((choice) => (
                        <label
                          key={choice}
                          htmlFor={`brand-accent-${choice}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <RadioGroupItem
                            value={choice}
                            id={`brand-accent-${choice}`}
                          />
                          <AccentDot
                            accent={choice === "default" ? "neutral" : choice}
                          />
                          {choice === "default"
                            ? t("accentDefault")
                            : tAccent(choice)}
                        </label>
                      ))}
                    </RadioGroup>
                    <FieldDescription>
                      {t("accentDescription")}
                    </FieldDescription>
                  </Field>
                )}
              />
            </FieldGroup>
            <div>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : null}
                {tCommon("save")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("logo")}</CardTitle>
          <CardDescription>{t("logoDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="max-w-2xl">
            <LogoField
              theme="light"
              current={data.logo?.src ?? null}
              hint={data.logoDark ? t("removeLightHint") : null}
              onWritten={refreshAfterWrite}
            />
            <LogoField
              theme="dark"
              current={data.logoDark?.src ?? null}
              disabledHint={data.logo ? null : t("logoDarkNeedsLight")}
              onWritten={refreshAfterWrite}
            />
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One logo slot: its current image, a file picker that uploads the pick at
 * once, and "Remove logo". A refusal shows inline, by code.
 */
function LogoField({
  theme,
  current,
  hint = null,
  disabledHint = null,
  onWritten,
}: {
  theme: BrandTheme;
  current: string | null;
  /** Shown under the picker (what a removal also does). */
  hint?: string | null;
  /** Set while this slot can't take a logo, with the reason. */
  disabledHint?: string | null;
  /** The refresh after a write; it reports its own failure, never rejects. */
  onWritten: (saved: BrandingData) => Promise<void>;
}) {
  const t = useTranslations("instance.branding");
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<LogoErrorCode | null>(null);
  const id = `brand-logo-${theme}`;
  const disabled = disabledHint !== null || busy !== null;
  const description =
    disabledHint ??
    hint ??
    (theme === "dark" ? t("logoDarkDescription") : null);

  async function write(
    kind: "upload" | "remove",
    request: () => Promise<BrandingData>
  ) {
    setBusy(kind);
    setError(null);
    let saved: BrandingData;
    try {
      saved = await request();
    } catch (caught) {
      setBusy(null);
      // A 401 is already sending the user to sign in.
      if (caught instanceof ApiError && caught.status === 401) return;
      if (kind === "upload") setError(logoErrorCode(caught));
      else reportError(caught);
      return;
    }
    toast.success(t(kind === "upload" ? "logoUploaded" : "logoRemoved"));
    // Reports its own failure: never the upload's error.
    try {
      await onWritten(saved);
    } finally {
      setBusy(null);
    }
  }

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    // The same file can be picked again after a refusal.
    event.currentTarget.value = "";
    if (file) void write("upload", () => uploadBrandLogo(theme, file));
  }

  return (
    <Field data-logo-theme={theme} data-invalid={error !== null || undefined}>
      <FieldLabel htmlFor={id}>
        {theme === "dark" ? t("logoDark") : t("logo")}
      </FieldLabel>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-lg border",
            theme === "dark" ? "bg-neutral-950" : "bg-white"
          )}
        >
          {current ? (
            <img src={current} alt="" className="size-6 object-contain" />
          ) : null}
        </div>
        <Input
          id={id}
          type="file"
          accept={LOGO_ACCEPT}
          disabled={disabled}
          aria-invalid={error !== null || undefined}
          onChange={onPick}
          className="max-w-xs"
        />
        {busy === "upload" ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : null}
        {current ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void write("remove", () => removeBrandLogo(theme))}
          >
            {busy === "remove" ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : null}
            {t("remove")}
          </Button>
        ) : null}
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{t(`error.${error}`)}</FieldError> : null}
    </Field>
  );
}
