import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import {
  defaultSpec,
  type SpecDraft,
  SpecEditor,
  toSpec,
  useSpecIssues,
} from "@/components/app-registration-fields";
import { SearchSelect } from "@/components/search-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
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
import { useRouter } from "@/i18n/navigation";
import { bundleImageFor, registerServicesSchema } from "@/lib/ci/registration";
import { issueMessage } from "@/lib/ci/registration-issues";
import { slugify } from "@/lib/setup/slug";
import {
  ciConnectionOptionsQuery,
  type RegistrableRepoRow,
  registrableReposQuery,
} from "@/web/api/ci-connections";
import { ApiError } from "@/web/api/client";
import { listServicesQuery, registerServices } from "@/web/api/service-catalog";
import { usePipelineFailureNotice } from "../env/deploys/target-form-dialog";

type ServiceDraft = {
  key: string;
  mode: "custom" | "generated";
  spec: SpecDraft;
};

const KEY_LENGTH = 60;

/**
 * The key a repository's name suggests for its next service: its last path
 * segment, else `-2`, `-3`… past the keys already taken.
 */
export function suggestServiceKey(
  repoFullName: string,
  taken: ReadonlySet<string>
): string {
  const base =
    slugify(repoFullName.split("/").at(-1) ?? repoFullName, KEY_LENGTH) ||
    "service";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/**
 * Register service(s): one or more services from one repository of a CI
 * connection, each with its key and pipeline (custom: the repository's own
 * file; generated: the Panel commits one from the build spec). The server
 * activates the repository, gives each service its notify secret and stores
 * it without an app.
 */
export function RegisterServicesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("serviceCatalog");
  const tIssues = useTranslations("appForm.issues");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const noticePipelineFailures = usePipelineFailureNotice();
  const connections = useQuery({
    ...ciConnectionOptionsQuery(),
    enabled: open,
  });
  const taken = useQuery({ ...listServicesQuery(), enabled: open }).data;
  const [connectionId, setConnectionId] = React.useState<string | null>(null);
  const [repo, setRepo] = React.useState<RegistrableRepoRow | null>(null);
  const [drafts, setDrafts] = React.useState<ServiceDraft[]>([]);
  const [submitted, setSubmitted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const only =
    connections.data?.length === 1 ? (connections.data[0]?.id ?? null) : null;
  const connection = connectionId ?? only;
  const repos = useQuery({
    ...registrableReposQuery(connection),
    enabled: open && connection !== null,
  });

  const takenKeys = React.useMemo(
    () => new Set((taken ?? []).map((s) => s.key)),
    [taken]
  );

  function reset() {
    setConnectionId(null);
    setRepo(null);
    setDrafts([]);
    setSubmitted(false);
    setServerError(null);
  }

  function newDraft(current: ServiceDraft[], repoName: string): ServiceDraft {
    const key = suggestServiceKey(
      repoName,
      new Set([...takenKeys, ...current.map((d) => d.key)])
    );
    return { key, mode: "custom", spec: defaultSpec(key) };
  }

  function pickRepo(row: RegistrableRepoRow | null) {
    setRepo(row);
    setServerError(null);
    setDrafts(row ? [newDraft([], row.fullName)] : []);
  }

  const input =
    connection && repo
      ? {
          services: drafts.map((d) => ({
            componentKey: d.key,
            ciConnectionId: connection,
            forgeRemoteId: repo.forgeRemoteId,
            bundleImage: bundleImageFor(d.key),
            pipelineMode: d.mode,
            ...(d.mode === "generated" ? { buildSpec: toSpec(d.spec) } : {}),
          })),
        }
      : null;
  const parsed = input ? registerServicesSchema.safeParse(input) : null;
  // A service row's first issue at `field`, else its first one the spec
  // editor does not show itself, translated.
  const issueOf = (index: number, field?: string): string | undefined => {
    if (!parsed || parsed.success) return undefined;
    const issue = parsed.error.issues.find(
      (i) =>
        i.path[0] === "services" &&
        i.path[1] === index &&
        (field === undefined
          ? i.path[2] !== "componentKey" &&
            (i.path[2] !== "buildSpec" || i.message === "sharedPipelineBranch")
          : i.path[2] === field)
    );
    if (!issue) return undefined;
    const { key, values } = issueMessage(issue);
    return tIssues(key, values);
  };
  const keyTaken = (key: string) => takenKeys.has(key);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!parsed?.success || drafts.some((d) => keyTaken(d.key))) return;
    setBusy(true);
    setServerError(null);
    try {
      const result = await registerServices(parsed.data);
      toast.success(t("registered", { count: result.services.length }));
      noticePipelineFailures(result.pipelineFileFailures);
      onOpenChange(false);
      reset();
      const [first] = result.services;
      if (result.services.length === 1 && first) {
        router.push(`/admin/services/${encodeURIComponent(first.key)}`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        setServerError(error.message);
      } else {
        throw error;
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("registerTitle")}</DialogTitle>
          <DialogDescription>{t("registerDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="register-connection">
                {t("connection")}
              </FieldLabel>
              <SearchSelect
                id="register-connection"
                aria-label={t("connection")}
                value={connection}
                onChange={(value) => {
                  setConnectionId(value);
                  pickRepo(null);
                }}
                options={(connections.data ?? []).map((c) => ({
                  value: c.id,
                  label: c.name,
                }))}
                placeholder={t("connectionPlaceholder")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="register-repository">
                {t("repository")}
              </FieldLabel>
              <SearchSelect
                id="register-repository"
                aria-label={t("repository")}
                value={repo?.forgeRemoteId ?? null}
                disabled={connection === null || repos.isPending}
                onChange={(value) =>
                  pickRepo(
                    repos.data?.find((r) => r.forgeRemoteId === value) ?? null
                  )
                }
                options={(repos.data ?? []).map((r) => ({
                  value: r.forgeRemoteId,
                  label: r.fullName,
                  hint: r.linkedComponentKey
                    ? t("repoBuilds", { service: r.linkedComponentKey })
                    : undefined,
                }))}
                placeholder={
                  repos.isError
                    ? t("reposFailed")
                    : connection !== null && repos.isPending
                      ? tCommon("loading")
                      : t("repositoryPlaceholder")
                }
              />
              {repo?.linkedComponentKey && (
                <FieldDescription>
                  {t("repoHasService", { service: repo.linkedComponentKey })}
                </FieldDescription>
              )}
            </Field>
            {repo &&
              drafts.map((draft, index) => (
                <ServiceDraftFields
                  key={index}
                  index={index}
                  draft={draft}
                  keyIssue={
                    submitted
                      ? keyTaken(draft.key)
                        ? t("keyTaken")
                        : issueOf(index, "componentKey")
                      : undefined
                  }
                  issue={submitted ? issueOf(index) : undefined}
                  onChange={(next) =>
                    setDrafts((all) =>
                      all.map((d, i) => (i === index ? next : d))
                    )
                  }
                  onRemove={
                    drafts.length > 1
                      ? () =>
                          setDrafts((all) => all.filter((_, i) => i !== index))
                      : undefined
                  }
                />
              ))}
            {repo && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() =>
                  setDrafts((all) => [...all, newDraft(all, repo.fullName)])
                }
              >
                <Plus data-icon="inline-start" />
                {t("addService")}
              </Button>
            )}
          </FieldGroup>
          {serverError && (
            <p role="alert" className="text-sm text-destructive">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!repo || busy}>
              {t("registerSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ServiceDraftFields({
  index,
  draft,
  keyIssue,
  issue,
  onChange,
  onRemove,
}: {
  index: number;
  draft: ServiceDraft;
  keyIssue: string | undefined;
  issue: string | undefined;
  onChange: (draft: ServiceDraft) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations("serviceCatalog");
  const tSetup = useTranslations("newEnvironment");
  const specIssues = useSpecIssues(draft.spec, "spec");
  const keyId = `register-key-${index}`;
  const modeId = `register-mode-${index}`;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <Field data-invalid={keyIssue ? true : undefined} className="flex-1">
          <FieldLabel htmlFor={keyId}>{t("serviceKey")}</FieldLabel>
          <Input
            id={keyId}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            value={draft.key}
            aria-invalid={keyIssue ? true : undefined}
            onChange={(e) =>
              onChange({ ...draft, key: e.target.value.trim().toLowerCase() })
            }
          />
          <FieldDescription>
            {t("serviceKeyHint", { image: bundleImageFor(draft.key) })}
          </FieldDescription>
          {keyIssue && <FieldError>{keyIssue}</FieldError>}
        </Field>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mt-6"
            aria-label={t("removeService", { key: draft.key })}
            onClick={onRemove}
          >
            <X />
          </Button>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={modeId}>{t("colMode")}</FieldLabel>
        <Select
          value={draft.mode}
          onValueChange={(value) =>
            onChange({
              ...draft,
              mode: value === "generated" ? "generated" : "custom",
            })
          }
        >
          <SelectTrigger id={modeId} aria-label={t("colMode")}>
            <SelectValue>
              {(value: string) =>
                value === "generated"
                  ? tSetup("pipelineModeGenerated")
                  : tSetup("pipelineModeCustom")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom">
              {tSetup("pipelineModeCustom")}
            </SelectItem>
            <SelectItem value="generated">
              {tSetup("pipelineModeGenerated")}
            </SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>{tSetup("pipelinesHint")}</FieldDescription>
      </Field>
      {draft.mode === "generated" && (
        <SpecEditor
          componentKey={draft.key}
          spec={draft.spec}
          issues={specIssues}
          path="spec"
          onChange={(change) =>
            onChange({ ...draft, spec: change(draft.spec) })
          }
        />
      )}
      {issue && <FieldError>{issue}</FieldError>}
    </div>
  );
}
