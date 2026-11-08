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
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { backendService } from "@/lib/services";
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
            <FormField
              control={form.control}
              name="backendMockTimeApiUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("mockTimeApiUrl")}</FormLabel>
                  <FormControl>
                    <Input
                      type="url"
                      disabled={readOnly}
                      placeholder="https://api.example.com/v1/clock"
                      {...field}
                    />
                  </FormControl>
                  <Hint>{t("mockTimeApiUrlHint")}</Hint>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="backendMockTimeApiKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("mockTimeApiKey")}</FormLabel>
                  <FormControl>
                    <PasswordInput
                      autoComplete="new-password"
                      disabled={readOnly}
                      placeholder={
                        backendService(environment).hasMockTimeApiKey
                          ? t("mockTimeApiKeyEditPlaceholder")
                          : ""
                      }
                      {...field}
                    />
                  </FormControl>
                  <Hint>{t("mockTimeApiKeyHint")}</Hint>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!readOnly && <SaveButton />}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
