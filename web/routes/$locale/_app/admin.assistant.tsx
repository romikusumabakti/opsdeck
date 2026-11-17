import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { PageHeader } from "@/components/page-header";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AssistantSettings,
  type AssistantUsage,
  getAssistantSettingsQuery,
  getAssistantUsageQuery,
  saveAssistantSettings,
  testAssistantConnection,
} from "@/web/api/assistant-settings";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

// Admin → Assistant: the code assistant's switch, Anthropic API key, model,
// effort and per-user daily cap. The key is write-only (only `hasApiKey` is
// read back).
export const Route = createFileRoute("/$locale/_app/admin/assistant")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { assistant: ["manage"] });
  },
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      loaderQuery(queryClient, getAssistantSettingsQuery()),
      loaderQuery(queryClient, getAssistantUsageQuery()),
    ]),
  component: AssistantPage,
});

function AssistantPage() {
  const t = useTranslations("assistantSettings");
  const settings = useSuspenseQuery(getAssistantSettingsQuery()).data;
  const usage = useSuspenseQuery(getAssistantUsageQuery()).data;
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex flex-col gap-4 max-w-4xl w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bot className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            </div>
            <CardDescription>{t("formDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <AssistantForm settings={settings} />
          </CardContent>
        </Card>
        <UsageCard usage={usage} />
      </div>
    </>
  );
}

const usd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);

function UsageCard({ usage }: { usage: AssistantUsage }) {
  const t = useTranslations("assistantSettings");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("usageTitle")}</CardTitle>
        <CardDescription>{t("usageDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>{t("usageRangeTotal", { amount: usd(usage.totalUsd) })}</span>
          <span>
            {t("usageMonthToDate", { amount: usd(usage.monthToDateUsd) })}
          </span>
        </div>
        {usage.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("usageEmpty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("usageDay")}</TableHead>
                <TableHead>{t("usageUser")}</TableHead>
                <TableHead className="text-right">{t("usageTurns")}</TableHead>
                <TableHead className="text-right">{t("usageCost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.rows.map((row) => (
                <TableRow key={`${row.day}-${row.userId}`}>
                  <TableCell>{row.day}</TableCell>
                  <TableCell>{row.userName}</TableCell>
                  <TableCell className="text-right">{row.turns}</TableCell>
                  <TableCell className="text-right">
                    {usd(row.costUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-sm text-muted-foreground">
          {t("creditHint")}{" "}
          <a
            href="https://platform.claude.com/settings/billing"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4"
          >
            {t("creditHintLink")}
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

function AssistantForm({ settings }: { settings: AssistantSettings }) {
  const t = useTranslations("assistantSettings");
  const [enabled, setEnabled] = useState(settings.enabled);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [model, setModel] = useState(settings.model);
  const [effort, setEffort] = useState(settings.effort);
  const [dailyCap, setDailyCap] = useState(String(settings.dailyCapUsd));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const cap = Number(dailyCap);
  const capValid = dailyCap.trim() !== "" && cap >= 0 && cap <= 1000;
  const keyPresent = settings.hasApiKey && !clearKey;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!capValid) return;
    setSaving(true);
    try {
      const result = await saveAssistantSettings({
        enabled,
        model,
        effort,
        dailyCapUsd: cap,
        ...(clearKey ? { apiKey: null } : apiKey.trim() && { apiKey }),
      });
      if (result.success) {
        toast.success(t("saved"));
        setApiKey("");
        setClearKey(false);
      } else {
        toast.error(result.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    try {
      const result = await testAssistantConnection();
      if (result.success) toast.success(t("testOk"));
      else toast.error(result.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field orientation="horizontal">
          <Switch
            id="assistant-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <FieldContent>
            <FieldLabel htmlFor="assistant-enabled" className="font-normal">
              {t("enabled")}
            </FieldLabel>
            <FieldDescription>{t("enabledDescription")}</FieldDescription>
          </FieldContent>
        </Field>
        <Field>
          <div className="flex items-center gap-2">
            <FieldLabel htmlFor="assistant-api-key">{t("apiKey")}</FieldLabel>
            <Badge variant={keyPresent ? "secondary" : "outline"}>
              {keyPresent ? t("set") : t("notSet")}
            </Badge>
          </div>
          <PasswordInput
            id="assistant-api-key"
            autoComplete="new-password"
            placeholder={keyPresent ? t("keepPlaceholder") : undefined}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <FieldDescription>
            {clearKey ? t("keyRemoved") : t("apiKeyDescription")}
          </FieldDescription>
          {settings.hasApiKey && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => setClearKey((value) => !value)}
            >
              {clearKey ? t("keepKey") : t("removeKey")}
            </Button>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="assistant-model">{t("model")}</FieldLabel>
          <Select
            value={model}
            onValueChange={(value) => value && setModel(value)}
          >
            <SelectTrigger id="assistant-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude-opus-5-5">{t("modelOpus")}</SelectItem>
              <SelectItem value="claude-sonnet-5-5">
                {t("modelSonnet")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field data-invalid={!capValid}>
          <FieldLabel htmlFor="assistant-daily-cap">{t("dailyCap")}</FieldLabel>
          <Input
            id="assistant-daily-cap"
            type="number"
            inputMode="decimal"
            min={0}
            max={1000}
            step="0.01"
            value={dailyCap}
            aria-invalid={!capValid}
            onChange={(event) => setDailyCap(event.target.value)}
          />
          <FieldDescription>{t("dailyCapDescription")}</FieldDescription>
        </Field>
        <AdvancedOptions>
          <Field>
            <FieldLabel htmlFor="assistant-effort">{t("effort")}</FieldLabel>
            <Select
              value={effort}
              onValueChange={(value) => value && setEffort(value)}
            >
              <SelectTrigger id="assistant-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{t("effortLow")}</SelectItem>
                <SelectItem value="medium">{t("effortMedium")}</SelectItem>
                <SelectItem value="high">{t("effortHigh")}</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>{t("effortDescription")}</FieldDescription>
          </Field>
        </AdvancedOptions>
        <div className="flex justify-end gap-2 pt-2">
          {settings.hasApiKey && (
            <Button
              type="button"
              variant="outline"
              onClick={onTest}
              disabled={testing || saving}
            >
              {testing ? t("testing") : t("test")}
            </Button>
          )}
          <Button type="submit" disabled={saving || !capValid}>
            {saving ? t("submitting") : t("save")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
