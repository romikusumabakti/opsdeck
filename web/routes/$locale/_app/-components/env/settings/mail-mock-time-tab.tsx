import { Controller } from "react-hook-form";
import { useTranslations } from "use-intl";
import { MailpitSettingsForm } from "@/components/mailpit-settings-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { findService } from "@/lib/services";
import type { MailpitSettings } from "@/web/api/mailpit-settings";
import { Hint, SaveButton } from "./fields";
import {
  type SettingsEnvironment,
  useSettingsFormContext,
} from "./settings-form";

/**
 * Mailpit (its own form and API) and the backend's time-mocking API. The
 * mock-time fields bind infrastructure, so editing them needs org
 * server:manage.
 */
export function MailMockTimeTab({
  environment,
  mailpit,
  canManageServers,
  onSave,
}: {
  environment: SettingsEnvironment;
  mailpit: MailpitSettings | null;
  canManageServers: boolean;
  onSave: () => Promise<void>;
}) {
  const t = useTranslations("environmentForm");
  const tSettings = useTranslations("environmentSettings");
  const tMailpit = useTranslations("mailpitSettings");
  const form = useSettingsFormContext();
  const readOnly = !canManageServers;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{tMailpit("title")}</CardTitle>
          <CardDescription>{tMailpit("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <MailpitSettingsForm
            environmentId={environment.id}
            settings={mailpit}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tSettings("mockTimeTitle")}</CardTitle>
          <CardDescription>{tSettings("mockTimeDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={form.handleSubmit(onSave)}
            className="flex flex-col gap-4"
          >
            {readOnly && <Hint>{t("infraReadOnlyHint")}</Hint>}
            <FieldGroup>
              <Controller
                name="backendMockTimeApiUrl"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="env-mock-time-api-url">
                      {t("mockTimeApiUrl")}
                    </FieldLabel>
                    <Input
                      type="url"
                      disabled={readOnly}
                      placeholder="https://api.example.com/v1/clock"
                      {...field}
                      id="env-mock-time-api-url"
                      aria-invalid={fieldState.invalid}
                    />
                    <Hint>{t("mockTimeApiUrlHint")}</Hint>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <Controller
                name="backendMockTimeApiKey"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="env-mock-time-api-key">
                      {t("mockTimeApiKey")}
                    </FieldLabel>
                    <PasswordInput
                      autoComplete="new-password"
                      disabled={readOnly}
                      placeholder={
                        findService(environment, "backend")?.hasMockTimeApiKey
                          ? t("mockTimeApiKeyEditPlaceholder")
                          : ""
                      }
                      {...field}
                      id="env-mock-time-api-key"
                      aria-invalid={fieldState.invalid}
                    />
                    <Hint>{t("mockTimeApiKeyHint")}</Hint>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            </FieldGroup>
            {!readOnly && <SaveButton />}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
