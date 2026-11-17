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
import { Textarea } from "@/components/ui/textarea";
import {
  PROVIDER_LABEL_KEYS,
  PROVIDERS,
  type Prices,
  type Provider,
  suggestedModels,
} from "@/lib/assistant/providers";
import {
  type AssistantSettings,
  type AssistantUsage,
  type ConnectionTest,
  getAssistantSettingsQuery,
  getAssistantUsageQuery,
  saveAssistantSettings,
  testAssistantConnection,
} from "@/web/api/assistant-settings";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

// Admin → Assistant: the code assistant's switch, provider, API key, model,
// effort, base URL and prices, per-user daily cap and organisation context.
// The key is write-only (only `hasApiKey` is read back).
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

// Mirrors ORG_CONTEXT_MAX in server/services/assistant-settings.ts.
const ORG_CONTEXT_MAX = 4000;

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
        {usage.estimatedRows > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("estimatedNotice")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const TEST_ERROR_KEYS = {
  auth: "testErrorAuth",
  quota: "testErrorQuota",
  unreachable: "testErrorUnreachable",
  model_not_found: "testErrorModelNotFound",
  failed: "testErrorFailed",
} as const satisfies Record<NonNullable<ConnectionTest["error"]>, string>;

const PRICE_FIELDS = [
  { key: "input", id: "assistant-price-input", label: "priceInput" },
  { key: "output", id: "assistant-price-output", label: "priceOutput" },
  {
    key: "cacheRead",
    id: "assistant-price-cache-read",
    label: "priceCacheRead",
  },
  {
    key: "cacheWrite",
    id: "assistant-price-cache-write",
    label: "priceCacheWrite",
  },
] as const;

type PriceText = Record<keyof Prices, string>;

const priceText = (prices: Prices | null): PriceText => ({
  input: prices ? String(prices.input) : "",
  output: prices ? String(prices.output) : "",
  cacheRead: prices ? String(prices.cacheRead) : "",
  cacheWrite: prices ? String(prices.cacheWrite) : "",
});

const validPrice = (text: string) => {
  const value = Number(text);
  return text.trim() !== "" && value >= 0 && value <= 1000;
};

/** The four prices as numbers; null when all are blank; "invalid" otherwise. */
function parsePrices(text: PriceText): Prices | null | "invalid" {
  const values = Object.values(text);
  if (values.every((value) => value.trim() === "")) return null;
  if (!values.every(validPrice)) return "invalid";
  return {
    input: Number(text.input),
    output: Number(text.output),
    cacheRead: Number(text.cacheRead),
    cacheWrite: Number(text.cacheWrite),
  };
}

function AssistantForm({ settings }: { settings: AssistantSettings }) {
  const t = useTranslations("assistantSettings");
  const [enabled, setEnabled] = useState(settings.enabled);
  const [provider, setProvider] = useState<Provider | null>(settings.provider);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  // A model id without a provider is a leftover of an older setup: not shown.
  const savedModel = settings.provider ? (settings.model ?? "") : "";
  const [model, setModel] = useState(savedModel);
  const [effort, setEffort] = useState(settings.effort);
  const [prices, setPrices] = useState(priceText(settings.prices));
  const [dailyCap, setDailyCap] = useState(String(settings.dailyCapUsd));
  const [orgContext, setOrgContext] = useState(settings.orgContext ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTest | null>(null);
  const [attempt, setAttempt] = useState(0);

  const cap = Number(dailyCap);
  const capValid = dailyCap.trim() !== "" && cap >= 0 && cap <= 1000;
  // The server drops the stored key when the provider or its base URL
  // changes: a key never goes to another host.
  const providerSwitched =
    settings.provider !== null && provider !== settings.provider;
  const baseUrlChanged =
    settings.provider !== null &&
    !providerSwitched &&
    baseUrl.trim() !== (settings.baseUrl ?? "");
  const keyDropped = providerSwitched || baseUrlChanged;
  const keyPresent = settings.hasApiKey && !clearKey && !keyDropped;
  // Test connection runs on the saved settings only.
  const unsaved =
    provider !== settings.provider ||
    apiKey.trim() !== "" ||
    clearKey ||
    baseUrl.trim() !== (settings.baseUrl ?? "") ||
    model.trim() !== savedModel;
  const suggestions = provider ? suggestedModels(provider) : [];
  const compatible = provider === "openai-compatible";
  const parsedPrices = parsePrices(prices);
  const pricesValid = parsedPrices !== "invalid";

  function onProviderChange(next: Provider) {
    if (next === provider) return;
    setProvider(next);
    // The key is dropped anyway: a pending removal has nothing left to remove.
    setClearKey(false);
    // A base URL belongs to its provider (the server clears it as well).
    setBaseUrl("");
    const known = suggestedModels(next).find((m) => m.id === model.trim());
    if (known) {
      setPrices(priceText(known.prices));
    } else {
      setModel("");
      setPrices(priceText(null));
    }
  }

  function onModelChange(value: string) {
    setModel(value);
    const known = suggestions.find((m) => m.id === value.trim());
    if (known) setPrices(priceText(known.prices));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setAttempt((n) => n + 1);
    if (!capValid || parsedPrices === "invalid") return;
    setSaving(true);
    try {
      const result = await saveAssistantSettings({
        enabled,
        ...(provider && { provider }),
        baseUrl: baseUrl.trim() || null,
        ...(model.trim() && { model: model.trim() }),
        effort,
        ...(parsedPrices && { prices: parsedPrices }),
        dailyCapUsd: cap,
        orgContext,
        ...(apiKey.trim()
          ? { apiKey }
          : clearKey && { apiKey: null }),
      });
      if (result.success) {
        toast.success(t("saved"));
        setApiKey("");
        setClearKey(false);
        // The result described the settings before this save.
        setTestResult(null);
      } else {
        toast.error(result.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAssistantConnection();
      if ("message" in result) {
        toast.error(result.message);
        return;
      }
      setTestResult(result);
      if (result.ok) toast.success(t("testOk"));
    } finally {
      setTesting(false);
    }
  }

  const baseUrlField = (
    <Field>
      <FieldLabel htmlFor="assistant-base-url">{t("baseUrl")}</FieldLabel>
      <Input
        id="assistant-base-url"
        type="url"
        inputMode="url"
        autoComplete="off"
        required={compatible}
        placeholder="https://llm.example.com/v1"
        value={baseUrl}
        onChange={(event) => {
          setBaseUrl(event.target.value);
          setClearKey(false);
        }}
      />
      <FieldDescription>{t("baseUrlHint")}</FieldDescription>
    </Field>
  );

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
          <FieldLabel htmlFor="assistant-provider">{t("provider")}</FieldLabel>
          <Select
            value={provider}
            onValueChange={(value) => value && onProviderChange(value)}
          >
            <SelectTrigger id="assistant-provider">
              <SelectValue placeholder={t("providerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(PROVIDER_LABEL_KEYS[value])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {compatible && baseUrlField}
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
            {keyDropped && settings.hasApiKey
              ? t("apiKeyRequired")
              : clearKey
                ? t("keyRemoved")
                : t("apiKeyDescription")}
          </FieldDescription>
          {settings.hasApiKey && !keyDropped && (
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
          <Input
            id="assistant-model"
            list="assistant-model-suggestions"
            autoComplete="off"
            maxLength={200}
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          />
          <datalist id="assistant-model-suggestions">
            {suggestions.map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
          <FieldDescription>{t("modelDescription")}</FieldDescription>
        </Field>
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
        <AdvancedOptions invalid={!pricesValid} attempt={attempt}>
          {!compatible && baseUrlField}
          <Field>
            <FieldLabel>{t("prices")}</FieldLabel>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {PRICE_FIELDS.map(({ key, id, label }) => {
                const invalid = !pricesValid && !validPrice(prices[key]);
                return (
                  <Field key={key} data-invalid={invalid}>
                    <FieldLabel htmlFor={id} className="font-normal">
                      {t(label)}
                    </FieldLabel>
                    <Input
                      id={id}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={1000}
                      step="any"
                      value={prices[key]}
                      aria-invalid={invalid}
                      onChange={(event) =>
                        setPrices((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                );
              })}
            </div>
            <FieldDescription>{t("pricesHint")}</FieldDescription>
          </Field>
        </AdvancedOptions>
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
        <Field>
          <FieldLabel htmlFor="assistant-org-context">
            {t("orgContext")}
          </FieldLabel>
          <Textarea
            id="assistant-org-context"
            rows={4}
            maxLength={ORG_CONTEXT_MAX}
            value={orgContext}
            onChange={(event) => setOrgContext(event.target.value)}
          />
          <FieldDescription>{t("orgContextDescription")}</FieldDescription>
        </Field>
        <div role="status" aria-live="polite">
          {/* It describes the stored settings, so not while they are being edited. */}
          {testResult && !unsaved && (
            <ConnectionTestResult result={testResult} />
          )}
        </div>
        {settings.hasApiKey && unsaved && (
          <p className="text-sm text-muted-foreground text-end">
            {t("testSaveFirst")}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          {settings.hasApiKey && (
            <Button
              type="button"
              variant="outline"
              onClick={onTest}
              disabled={testing || saving || unsaved}
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

function ConnectionTestResult({ result }: { result: ConnectionTest }) {
  const t = useTranslations("assistantSettings");
  if (result.error) {
    return (
      <p className="text-sm text-destructive">
        {t(TEST_ERROR_KEYS[result.error])}
      </p>
    );
  }
  const rows = [
    { label: t("testTools"), supported: result.tools },
    { label: t("testDrafts"), supported: result.structuredOutput },
  ];
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map(({ label, supported }) => (
        <li key={label} className="flex items-center gap-2">
          <span>{label}</span>
          <Badge variant={supported ? "secondary" : "outline"}>
            {supported ? t("testSupported") : t("testUnsupported")}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
