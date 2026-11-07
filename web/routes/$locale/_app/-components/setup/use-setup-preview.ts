import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  buildSetupInput,
  type DraftContext,
  type EnvironmentDraft,
  issuesByField,
  parseSetupInput,
} from "@/lib/setup/draft";
import type { SetupIssue } from "@/lib/setup/schema";
import { baseEnvSlug } from "@/lib/setup/slug";
import { listDatabaseHostsQuery } from "@/web/api/database-hosts";
import {
  setupAccessPoliciesQuery,
  setupOptionsQuery,
  setupPreviewQuery,
} from "@/web/api/setup";
import type { ProvisioningLookups } from "../env/provisioning-step-sentence";
import { useIssueMessage } from "./use-issue-message";

const PREVIEW_DEBOUNCE_MS = 500;

/** Stands in for the app's id while it is not registered yet (New app). */
export const UNREGISTERED_APP_ID = "00000000-0000-7000-8000-000000000000";

/**
 * Everything the setup forms derive from a draft: the lists a project offers,
 * the draft's resolved context, the API input and its client-side issues, and
 * the debounced server preview with its suggestions fed back as defaults.
 * Shared by the Add environment page and the New app stepper. With no
 * `appId` (the app is not registered yet) no preview runs, and the issues
 * are the ones the browser can see by itself.
 */
export function useSetupPreview({
  draft,
  appId,
  projectKey,
  entryService = null,
}: {
  draft: EnvironmentDraft;
  appId: string | null;
  projectKey: string;
  entryService?: string | null;
}) {
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
    appId: appId ?? UNREGISTERED_APP_ID,
    projectKey,
    slug:
      serverSlug?.name === draft.name
        ? serverSlug.slug
        : baseEnvSlug(draft.name),
    suggestedServices: suggestions.suggestedServices,
    suggestedEntryPort: suggestions.suggestedEntryPort,
    defaultZoneId: options?.zones[0]?.id ?? "",
    entryService,
  };
  const real = buildSetupInput(draft, draftCtx);
  const realParsed = parseSetupInput(real.input);
  const probe = buildSetupInput(draft, { ...draftCtx, probe: true });
  const probeParsed = parseSetupInput(probe.input);

  const inputKey =
    appId !== null && probeParsed.ok ? JSON.stringify(probeParsed.input) : null;
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

  // A create needs a successful preview of this very input: not a failed
  // one (no data), nor the previous input's answer shown while loading.
  // Without an appId there is no preview to wait for.
  const previewFailed = previewQuery.isError && inputKey !== null;
  const checking =
    appId !== null &&
    !previewFailed &&
    (inputKey === null ||
      inputKey !== debouncedKey ||
      previewQuery.isFetching ||
      !previewQuery.isSuccess ||
      previewQuery.isPlaceholderData);

  const portUnresolved =
    draft.domain.kind === "tunnel" &&
    (draft.domain.entryPort ??
      suggestions.suggestedEntryPort?.toString() ??
      "") === "";
  const issues: SetupIssue[] = [
    ...real.issues,
    ...(realParsed.ok ? [] : realParsed.issues),
    ...(appId !== null && probeParsed.ok && preview
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

  return {
    options,
    databaseHosts,
    policiesQuery,
    draftCtx,
    realParsed,
    previewQuery,
    preview,
    previewFailed,
    checking,
    issues,
    byField,
    message,
    lookups,
  };
}
