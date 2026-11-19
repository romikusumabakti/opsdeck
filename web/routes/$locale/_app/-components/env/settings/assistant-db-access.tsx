import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { assistantDbUnavailableReason } from "@/lib/assistant-db/availability";
import { findService } from "@/lib/services";
import { ApiError } from "@/web/api/client";
import { setAssistantDbAccess } from "@/web/api/environments";
import { useTeardownErrorText } from "../use-teardown-error-text";
import { Hint } from "./fields";
import type { SettingsEnvironment } from "./settings-form";

/**
 * "Let the Assistant query this database (read-only)" (Stage 9 spec F.1).
 * Saves on its own, outside the Database form: switching it creates or
 * drops the dedicated read-only login on the database server. Only admin
 * and infra (org server:manage) may switch it; a database the Panel can't
 * administer shows the switch off and disabled with the reason.
 */
export function AssistantDbAccess({
  environment,
  canManageServers,
}: {
  environment: SettingsEnvironment;
  canManageServers: boolean;
}) {
  const t = useTranslations("environmentSettings.assistantDb");
  const teardownErrorText = useTeardownErrorText();
  const [busy, setBusy] = useState(false);
  const service = findService(environment, "db");
  if (!service) return null;
  const reason = assistantDbUnavailableReason({
    dbKind: service.dbKind,
    serviceType: service.serviceType,
    dbType: service.dbType,
    dbName: service.dbName,
    hasAdminPassword: service.hasDbPassword,
  });
  const enabled = service.assistantDbEnabled;
  // Off already (or never on): an unusable database can't be switched on.
  const blocked = reason !== null && !enabled;

  async function onChange(next: boolean) {
    setBusy(true);
    try {
      await setAssistantDbAccess(environment.id, next);
      toast.success(t(next ? "enabled" : "disabled"));
    } catch (error) {
      // The server words its own refusals; a teardown's uses its catalog.
      toast.error(
        error instanceof ApiError && error.code === "teardownRunning"
          ? teardownErrorText(error.code)
          : error instanceof Error
            ? error.message
            : String(error)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <TriangleAlert />
          <AlertDescription>{t("warning")}</AlertDescription>
        </Alert>
        <div className="flex items-center gap-2">
          <Switch
            id="env-assistant-db"
            checked={enabled}
            disabled={!canManageServers || blocked || busy}
            onCheckedChange={(checked) => void onChange(checked)}
          />
          <Label htmlFor="env-assistant-db">{t("toggle")}</Label>
        </div>
        {enabled && service.assistantDbLogin && (
          <Hint>{t("enabledAs", { login: service.assistantDbLogin })}</Hint>
        )}
        {!enabled && service.assistantDbLogin && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Hint>{t("leftover", { login: service.assistantDbLogin })}</Hint>
            {canManageServers && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void onChange(false)}
              >
                {t("retryRemove")}
              </Button>
            )}
          </div>
        )}
        {blocked && <Hint>{t(`unavailable.${reason}`)}</Hint>}
        {!canManageServers && <Hint>{t("adminOnly")}</Hint>}
      </CardContent>
    </Card>
  );
}
