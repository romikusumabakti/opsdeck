import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRouter } from "@/i18n/navigation";
import {
  applyCopySource,
  baseEnvSlug,
  buildSetupInput,
  type DraftContext,
  type EnvironmentDraft,
  emptyDraft,
  issuesByField,
  parseSetupInput,
} from "@/lib/setup/draft";
import type { SetupIssue } from "@/lib/setup/schema";
import { ApiError } from "@/web/api/client";
import { listDatabaseHostsQuery } from "@/web/api/database-hosts";
import {
  copySourceQuery,
  createEnvironmentSetup,
  setupAccessPoliciesQuery,
  setupOptionsQuery,
  setupPreviewQuery,
} from "@/web/api/setup";
import type { ProvisioningLookups } from "../env/provisioning-step-sentence";
import { EnvironmentSections } from "./environment-sections";
import { SetupReview } from "./review";
import { useIssueMessage } from "./use-issue-message";

const PREVIEW_DEBOUNCE_MS = 500;

export type AddEnvironmentProject = {
  id: string;
  key: string;
  name: string;
  environments: { id: string; name: string; appId: string | null }[];
};

export type AddEnvironmentApp = {
  id: string;
  components: {
    componentKey: string;
    buildSpec?: { branches: string[] } | null;
  }[];
};

/**
 * The Add environment page's body: the project, name and copy source, the
 * five sections prefilled from the copy source, and the Review. Every change
 * re-runs the preview (debounced); the create is sent only from a clean one.
 */
export function AddEnvironmentForm({
  app,
  projects,
  canPublish,
  initialProjectKey,
}: {
  app: AddEnvironmentApp;
  /** Projects the caller may create environments in, with their environments. */
  projects: AddEnvironmentProject[];
  canPublish: boolean;
  initialProjectKey?: string;
}) {
  const t = useTranslations("setupWizard");
  const router = useRouter();
  const queryClient = useQueryClient();

  const components = React.useMemo(
    () =>
      app.components.map((c) => ({
        componentKey: c.componentKey,
        branch: c.buildSpec?.branches[0],
      })),
    [app.components]
  );
  const [draft, setDraft] = React.useState<EnvironmentDraft>(() =>
    emptyDraft(
      (
        projects.find((p) => p.key === initialProjectKey) ??
        (projects.length === 1 ? projects[0] : undefined)
      )?.id ?? "",
      components
    )
  );
  const [copying, setCopying] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const project = projects.find((p) => p.id === draft.projectId);
  const projectKey = project?.key ?? "";
  const sources = projects.flatMap((p) =>
    p.environments
      .filter((e) => e.appId === app.id)
      .map((e) => ({ id: e.id, label: `${p.name} / ${e.name}` }))
  );

  const options = useQuery({
    ...setupOptionsQuery(draft.projectId),
    enabled: draft.projectId !== "",
  }).data;
  const databaseHosts = useQuery(listDatabaseHostsQuery()).data ?? [];
  const policiesQuery = useQuery({
    ...setupAccessPoliciesQuery(draft.projectId),
    enabled: draft.projectId !== "" && draft.domain.kind === "tunnel",
    retry: false,
  });

  // The input follows the draft; the preview follows the input 500 ms after
  // the last change. The suggestions it returns (container names, the entry
  // port, the URL name) feed back into the draft's defaults.
  const [suggestions, setSuggestions] = React.useState<
    Pick<DraftContext, "suggestedServices" | "suggestedEntryPort">
  >({ suggestedServices: [], suggestedEntryPort: null });
  // The URL name is the server's (it avoids names taken) once its preview is
  // for this very name; until then the plain slug of the typed one.
  const [serverSlug, setServerSlug] = React.useState<{
    name: string;
    slug: string;
  } | null>(null);

  const draftCtx: DraftContext = {
    appId: app.id,
    projectKey,
    componentCount: app.components.length,
    slug:
      serverSlug?.name === draft.name
        ? serverSlug.slug
        : baseEnvSlug(draft.name),
    suggestedServices: suggestions.suggestedServices,
    suggestedEntryPort: suggestions.suggestedEntryPort,
    defaultZoneId: options?.zones[0]?.id ?? "",
  };
  const real = buildSetupInput(draft, draftCtx);
  const realParsed = parseSetupInput(real.input);
  const probe = buildSetupInput(draft, { ...draftCtx, probe: true });
  const probeParsed = parseSetupInput(probe.input);

  const inputKey = probeParsed.ok ? JSON.stringify(probeParsed.input) : null;
  const debouncedKey = useDebouncedValue(inputKey, PREVIEW_DEBOUNCE_MS);
  const previewInput = React.useMemo(
    () => (debouncedKey ? JSON.parse(debouncedKey) : null),
    [debouncedKey]
  );
  const previewQuery = useQuery(setupPreviewQuery(previewInput));
  const preview = previewQuery.data;

  React.useEffect(() => {
    if (!preview) return;
    setSuggestions({
      suggestedServices: preview.suggestedServices,
      suggestedEntryPort: preview.suggestedEntryPort,
    });
    if (previewInput && !previewQuery.isPlaceholderData) {
      setServerSlug({ name: previewInput.name, slug: preview.slug });
    }
  }, [preview, previewInput, previewQuery.isPlaceholderData]);

  const checking =
    inputKey !== debouncedKey || previewQuery.isFetching || inputKey === null;

  const portUnresolved =
    draft.domain.kind === "tunnel" &&
    (draft.domain.entryPort ??
      suggestions.suggestedEntryPort?.toString() ??
      "") === "";
  const issues: SetupIssue[] = [
    ...real.issues,
    ...(realParsed.ok ? [] : realParsed.issues),
    ...(probeParsed.ok && preview
      ? preview.issues.filter(
          (i) => !(portUnresolved && i.field === "domain.entryPort")
        )
      : []),
  ].filter(
    (issue, i, all) =>
      all.findIndex((x) => x.field === issue.field && x.code === issue.code) ===
      i
  );
  const byField = issuesByField(issues);
  const message = useIssueMessage(projectKey);

  const lookups = React.useMemo<ProvisioningLookups>(() => {
    const servers = new Map(
      (options?.servers ?? []).map((s) => [s.id, `${s.name} (${s.host})`])
    );
    const tunnels = new Map(
      (options?.tunnels ?? []).map((x) => [x.id, x.name])
    );
    const policies = new Map(
      (policiesQuery.data ?? []).map((p) => [p.id, p.name])
    );
    return {
      serverLabel: (id) => servers.get(id),
      databaseHost: (id) => databaseHosts.find((h) => h.id === id),
      componentKey: (id) => id,
      tunnelName: (id) => tunnels.get(id),
      policyName: (id) => policies.get(id),
    };
  }, [options, databaseHosts, policiesQuery.data]);

  async function onCopyFrom(id: string | null) {
    if (!id) {
      setDraft((d) => ({
        ...emptyDraft(d.projectId, components),
        name: d.name,
      }));
      return;
    }
    setCopying(true);
    try {
      const source = await queryClient.fetchQuery(copySourceQuery(id));
      setDraft((d) =>
        applyCopySource(
          d,
          source,
          (options?.servers ?? []).map((s) => s.id)
        )
      );
    } catch {
      toast.error(t("addEnvironment.copyFailed"));
    } finally {
      setCopying(false);
    }
  }

  async function onSubmit() {
    // Never a create while an issue remains or the preview is out of date.
    if (!realParsed.ok || issues.length > 0 || checking) return;
    setSubmitting(true);
    try {
      const created = await createEnvironmentSetup(realParsed.input);
      toast.success(t("addEnvironment.created"));
      if (created.provisioningError) {
        toast.warning(t("addEnvironment.provisioningNotStarted"));
      }
      router.push(`/${created.projectKey}/${created.envSlug}/deploys`);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
        // The world moved on (a name taken meanwhile): look again.
        await previewQuery.refetch();
      } else {
        throw error;
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field data-invalid={byField.name ? true : undefined}>
            <FieldLabel htmlFor="env-project">
              {t("addEnvironment.project")}
            </FieldLabel>
            <FieldContent>
              <Select
                value={draft.projectId || null}
                onValueChange={(value) =>
                  setDraft((d) => ({
                    ...d,
                    projectId: value ?? "",
                    serverId: "",
                  }))
                }
                disabled={projects.length === 0}
              >
                <SelectTrigger
                  id="env-project"
                  aria-label={t("addEnvironment.project")}
                >
                  <SelectValue
                    placeholder={t("addEnvironment.projectPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {projects.length === 0 && (
                <FieldDescription>
                  {t("addEnvironment.noProjects")}
                </FieldDescription>
              )}
            </FieldContent>
          </Field>

          <Field data-invalid={byField.name ? true : undefined}>
            <FieldLabel htmlFor="env-name">
              {t("addEnvironment.name")}
            </FieldLabel>
            <FieldContent>
              <Input
                id="env-name"
                autoComplete="off"
                placeholder={t("addEnvironment.namePlaceholder")}
                value={draft.name}
                aria-invalid={byField.name ? true : undefined}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
              />
              {byField.name && <FieldError>{message(byField.name)}</FieldError>}
            </FieldContent>
          </Field>

          <Field
            data-invalid={byField.copyFromEnvironmentId ? true : undefined}
          >
            <FieldLabel htmlFor="env-copy">
              {t("addEnvironment.copyFrom")}
            </FieldLabel>
            <FieldContent>
              <Select
                value={draft.copyFromEnvironmentId ?? "__none"}
                onValueChange={(value) =>
                  onCopyFrom(value && value !== "__none" ? value : null)
                }
                disabled={copying || !options}
              >
                <SelectTrigger
                  id="env-copy"
                  aria-label={t("addEnvironment.copyFrom")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">
                    {t("addEnvironment.copyFromNone")}
                  </SelectItem>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {t("addEnvironment.copyFromHint")}
              </FieldDescription>
              {byField.copyFromEnvironmentId && (
                <FieldError>
                  {message(byField.copyFromEnvironmentId)}
                </FieldError>
              )}
            </FieldContent>
          </Field>
        </CardContent>
      </Card>

      <EnvironmentSections
        draft={draft}
        onChange={(update) => setDraft(update)}
        draftCtx={draftCtx}
        options={options}
        databaseHosts={databaseHosts}
        policies={policiesQuery.data}
        policiesFailed={policiesQuery.isError}
        canPublish={canPublish}
        issues={byField}
      />

      <SetupReview
        creates={preview?.creates ?? []}
        plan={preview?.plan ?? []}
        lookups={lookups}
        issues={issues}
        projectKey={projectKey}
        checking={checking}
        submitting={submitting}
        onSubmit={onSubmit}
      />
    </div>
  );
}
