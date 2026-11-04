import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Check, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import {
  bundleImageFor,
  type RegisterAppInput,
  registerAppSchema,
} from "@/lib/ci/registration";
import {
  type IssueKey,
  type IssueMessage,
  issueMessage,
} from "@/lib/ci/registration-issues";
import { cn } from "@/lib/utils";
import {
  listCiConnectionOptionsQuery,
  listConnectionReposQuery,
  pipelinePreviewQuery,
  type RegistrableRepoRow,
  registerApp,
} from "@/web/api/apps";
import { ApiError } from "@/web/api/client";

// The "Register app" form: per component, a CI connection, a repository from
// that connection, the component key (prefilled from the repo name) and the
// pipeline mode; generated components get a build spec editor with the YAML
// the Panel will serve. Validated with the API's own schema before it submits.

type ImageDraft = { name: string; dockerfile: string; context: string };
type FileDraft = { from: string; to: string };
type CheckDraft = {
  name: string;
  image: string;
  dir: string;
  commands: string;
};
type SpecDraft = {
  branches: string;
  tagShaLength: string;
  timeoutMinutes: string;
  images: ImageDraft[];
  bundleFiles: FileDraft[];
  checks: CheckDraft[];
};
type ComponentDraft = {
  id: number;
  ciConnectionId: string;
  repo: RegistrableRepoRow | null;
  componentKey: string;
  pipelineMode: "custom" | "generated";
  spec: SpecDraft;
};

let nextId = 1;

/** A key-shaped slug: lowercase letters, digits and single dashes. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function repoName(fullName: string): string {
  return fullName.split("/").pop() ?? fullName;
}

function defaultSpec(componentKey: string): SpecDraft {
  return {
    branches: "main",
    tagShaLength: "7",
    timeoutMinutes: "60",
    images: [{ name: componentKey, dockerfile: "Dockerfile", context: "." }],
    bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
    checks: [],
  };
}

function newComponent(ciConnectionId: string): ComponentDraft {
  return {
    id: nextId++,
    ciConnectionId,
    repo: null,
    componentKey: "",
    pipelineMode: "custom",
    spec: defaultSpec(""),
  };
}

function toSpec(draft: SpecDraft) {
  return {
    branches: draft.branches
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean),
    tagShaLength: Number(draft.tagShaLength),
    timeoutMinutes: Number(draft.timeoutMinutes),
    images: draft.images,
    bundleFiles: draft.bundleFiles,
    checks: draft.checks.map((check) => ({
      name: check.name,
      image: check.image,
      dir: check.dir,
      commands: check.commands
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    })),
  };
}

function toInput(
  appKey: string,
  name: string,
  components: ComponentDraft[]
): unknown {
  return {
    appKey: appKey.trim(),
    name: name.trim(),
    components: components.map((c) => ({
      componentKey: c.componentKey.trim(),
      ciConnectionId: c.ciConnectionId,
      forgeRemoteId: c.repo?.forgeRemoteId ?? "",
      bundleImage: bundleImageFor(c.componentKey.trim()),
      pipelineMode: c.pipelineMode,
      buildSpec: c.pipelineMode === "generated" ? toSpec(c.spec) : undefined,
    })),
  };
}

/**
 * Translated issue messages keyed by their dotted path, e.g.
 * "components.0.componentKey". The schema's own text is never shown: each
 * issue maps to an `appForm.issues` key (lib/ci/registration-issues.ts).
 */
type Issues = Map<string, string>;

function issuesOf(
  input: unknown,
  translate: (key: IssueKey, values?: IssueMessage["values"]) => string
): Issues {
  const result = registerAppSchema.safeParse(input);
  const issues: Issues = new Map();
  if (result.success) return issues;
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    if (issues.has(path)) continue;
    const { key, values } = issueMessage(issue);
    issues.set(path, translate(key, values));
  }
  return issues;
}

/** The first issue at `prefix` or below it. */
function issueAt(issues: Issues, prefix: string): string | undefined {
  for (const [key, message] of issues) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return message;
  }
  return undefined;
}

export function AppRegisterForm() {
  const t = useTranslations("appForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const connections = useSuspenseQuery(listCiConnectionOptionsQuery()).data;
  const firstConnection = connections[0]?.id ?? "";

  const [appKey, setAppKey] = useState("");
  const [name, setName] = useState("");
  const [components, setComponents] = useState<ComponentDraft[]>(() => [
    newComponent(firstConnection),
  ]);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const input = useMemo(
    () => toInput(appKey, name, components),
    [appKey, name, components]
  );
  const tIssues = useTranslations("appForm.issues");
  const issues = useMemo(
    () =>
      submitted
        ? issuesOf(input, (key, values) => tIssues(key, values))
        : new Map<string, string>(),
    [submitted, input, tIssues]
  );
  const dirty =
    appKey !== "" || name !== "" || components.some((c) => c.repo !== null);
  useUnsavedChanges(dirty && !submitting);

  function update(id: number, change: (c: ComponentDraft) => ComponentDraft) {
    setComponents((list) => list.map((c) => (c.id === id ? change(c) : c)));
  }

  function pickRepo(id: number, repo: RegistrableRepoRow) {
    const slug = slugify(repoName(repo.fullName));
    const isFirst = components[0]?.id === id;
    update(id, (c) => {
      const componentKey = c.componentKey || slug;
      return {
        ...c,
        repo,
        componentKey,
        spec: c.repo ? c.spec : defaultSpec(componentKey),
      };
    });
    if (isFirst && !appKey) setAppKey(slug);
    if (isFirst && !name) setName(repoName(repo.fullName));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    const parsed = registerAppSchema.safeParse(input);
    if (!parsed.success) return;
    setSubmitting(true);
    try {
      const created = await registerApp(parsed.data as RegisterAppInput);
      toast.success(t("registered", { name: created.name }));
      for (const c of created.components) {
        if (c.fallbackCommitError) {
          toast.warning(
            t("fallbackNotCommitted", {
              component: c.componentKey,
              reason: c.fallbackCommitError,
            })
          );
        }
      }
      setAppKey("");
      setName("");
      setComponents([]);
      router.push(`/apps/${created.appKey}`);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
      } else {
        throw error;
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("appTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("name")}
            value={name}
            onChange={setName}
            error={issues.get("name")}
          />
          <TextField
            label={t("appKey")}
            description={t("appKeyDescription")}
            value={appKey}
            onChange={setAppKey}
            error={issues.get("appKey")}
            mono
          />
        </CardContent>
      </Card>

      {components.map((component, index) => (
        <ComponentEditor
          key={component.id}
          index={index}
          component={component}
          connections={connections}
          issues={issues}
          canRemove={components.length > 1}
          onRemove={() =>
            setComponents((list) => list.filter((c) => c.id !== component.id))
          }
          onChange={(change) => update(component.id, change)}
          onPickRepo={(repo) => pickRepo(component.id, repo)}
        />
      ))}

      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() =>
          setComponents((list) => [...list, newComponent(firstConnection)])
        }
      >
        <Plus className="size-4" />
        {t("addComponent")}
      </Button>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push("/apps")}
          disabled={submitting}
        >
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

function TextField({
  label,
  description,
  value,
  onChange,
  error,
  mono,
  readOnly,
  placeholder,
  type,
}: {
  label: string;
  description?: string;
  value: string;
  onChange?: (value: string) => void;
  error?: string;
  mono?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  type?: "text" | "number";
}) {
  const id = useId();
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type ?? "text"}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={cn(mono && "font-mono")}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}

function ComponentEditor({
  index,
  component,
  connections,
  issues,
  canRemove,
  onRemove,
  onChange,
  onPickRepo,
}: {
  index: number;
  component: ComponentDraft;
  connections: { id: string; name: string; hasForgeToken: boolean }[];
  issues: Issues;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (change: (c: ComponentDraft) => ComponentDraft) => void;
  onPickRepo: (repo: RegistrableRepoRow) => void;
}) {
  const t = useTranslations("appForm");
  const path = `components.${index}`;
  const connection = connections.find((c) => c.id === component.ciConnectionId);
  const key = component.componentKey.trim();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("componentTitle", { number: index + 1 })}
        </CardTitle>
        {canRemove && (
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              aria-label={t("removeComponent")}
            >
              <Trash2 className="size-4" />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel>{t("connection")}</FieldLabel>
          <Select
            value={component.ciConnectionId || undefined}
            onValueChange={(value) =>
              onChange((c) => ({
                ...c,
                ciConnectionId: value ?? "",
                repo: null,
              }))
            }
          >
            <SelectTrigger>
              <SelectValue placeholder={t("connectionPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connection && !connection.hasForgeToken && (
            <FieldDescription>{t("noForgeToken")}</FieldDescription>
          )}
        </Field>

        <RepoPicker
          connectionId={component.ciConnectionId || null}
          selected={component.repo}
          onPick={onPickRepo}
          onClear={() => onChange((c) => ({ ...c, repo: null }))}
          error={issues.get(`${path}.forgeRemoteId`)}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("componentKey")}
            value={component.componentKey}
            onChange={(value) =>
              onChange((c) => ({ ...c, componentKey: value }))
            }
            error={issues.get(`${path}.componentKey`)}
            mono
          />
          <TextField
            label={t("bundleImage")}
            description={t("bundleImageDescription")}
            value={key ? bundleImageFor(key) : ""}
            error={issues.get(`${path}.bundleImage`)}
            readOnly
            mono
          />
        </div>

        <Field>
          <FieldLabel>{t("mode")}</FieldLabel>
          <Select
            value={component.pipelineMode}
            onValueChange={(value) =>
              onChange((c) => ({
                ...c,
                pipelineMode: value === "generated" ? "generated" : "custom",
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">{t("modeCustom")}</SelectItem>
              <SelectItem value="generated">{t("modeGenerated")}</SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription>
            {component.pipelineMode === "generated"
              ? t("modeGeneratedDescription")
              : t("modeCustomDescription")}
          </FieldDescription>
        </Field>

        {component.pipelineMode === "generated" && (
          <SpecEditor
            componentKey={key}
            spec={component.spec}
            issues={issues}
            path={`${path}.buildSpec`}
            onChange={(change) =>
              onChange((c) => ({ ...c, spec: change(c.spec) }))
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

function RepoPicker({
  connectionId,
  selected,
  onPick,
  onClear,
  error,
}: {
  connectionId: string | null;
  selected: RegistrableRepoRow | null;
  onPick: (repo: RegistrableRepoRow) => void;
  onClear: () => void;
  error?: string;
}) {
  const t = useTranslations("appForm");
  const [search, setSearch] = useState("");
  const repos = useQuery({
    ...listConnectionReposQuery(connectionId),
    enabled: connectionId !== null && selected === null,
  });

  if (selected) {
    return (
      <Field>
        <FieldLabel>{t("repo")}</FieldLabel>
        <div className="flex items-center gap-2">
          <Check className="size-4 text-muted-foreground" />
          <span className="font-mono text-sm">{selected.fullName}</span>
          {selected.active && (
            <Badge variant="secondary">{t("alreadyActive")}</Badge>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            {t("changeRepo")}
          </Button>
        </div>
      </Field>
    );
  }

  const term = search.trim().toLowerCase();
  const matches = (repos.data ?? [])
    .filter((repo) => repo.fullName.toLowerCase().includes(term))
    .slice(0, 50);

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel>{t("repo")}</FieldLabel>
      <div className="relative">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("repoSearch")}
          className="ps-8"
          disabled={connectionId === null}
        />
      </div>
      <div className="max-h-64 overflow-y-auto rounded-lg border">
        {repos.isPending && connectionId !== null ? (
          <p className="p-3 text-sm text-muted-foreground">
            <Loader2 className="me-2 inline size-4 animate-spin" />
            {t("reposLoading")}
          </p>
        ) : repos.isError ? (
          <p className="p-3 text-sm text-destructive">
            {repos.error instanceof ApiError
              ? repos.error.message
              : t("reposFailed")}
          </p>
        ) : matches.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t("noRepos")}</p>
        ) : (
          <ul className="divide-y">
            {matches.map((repo) => (
              <li key={repo.forgeRemoteId}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={repo.linkedComponentKey !== null}
                  onClick={() => onPick(repo)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {repo.fullName}
                  </span>
                  {repo.linkedComponentKey ? (
                    <Badge variant="outline">
                      {t("linkedTo", { component: repo.linkedComponentKey })}
                    </Badge>
                  ) : repo.active ? (
                    <Badge variant="secondary">{t("alreadyActive")}</Badge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <FieldError>{t("repoRequired")}</FieldError>}
    </Field>
  );
}

function SpecEditor({
  componentKey,
  spec,
  issues,
  path,
  onChange,
}: {
  componentKey: string;
  spec: SpecDraft;
  issues: Issues;
  path: string;
  onChange: (change: (spec: SpecDraft) => SpecDraft) => void;
}) {
  const t = useTranslations("appForm");

  function setRow<K extends "images" | "bundleFiles" | "checks">(
    list: K,
    index: number,
    patch: Partial<SpecDraft[K][number]>
  ) {
    onChange((s) => ({
      ...s,
      [list]: s[list].map((row, i) =>
        i === index ? { ...row, ...patch } : row
      ),
    }));
  }

  function removeRow(list: "images" | "bundleFiles" | "checks", index: number) {
    onChange((s) => ({ ...s, [list]: s[list].filter((_, i) => i !== index) }));
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label={t("branches")}
          description={t("branchesDescription")}
          value={spec.branches}
          onChange={(branches) => onChange((s) => ({ ...s, branches }))}
          error={issueAt(issues, `${path}.branches`)}
          mono
        />
        <TextField
          label={t("tagShaLength")}
          type="number"
          value={spec.tagShaLength}
          onChange={(tagShaLength) => onChange((s) => ({ ...s, tagShaLength }))}
          error={issues.get(`${path}.tagShaLength`)}
        />
        <TextField
          label={t("timeoutMinutes")}
          type="number"
          value={spec.timeoutMinutes}
          onChange={(timeoutMinutes) =>
            onChange((s) => ({ ...s, timeoutMinutes }))
          }
          error={issues.get(`${path}.timeoutMinutes`)}
        />
      </div>

      <FieldSet>
        <FieldLegend variant="label">{t("images")}</FieldLegend>
        {spec.images.map((image, i) => (
          <RowFields
            key={i}
            onRemove={
              spec.images.length > 1 ? () => removeRow("images", i) : undefined
            }
            error={issueAt(issues, `${path}.images.${i}`)}
          >
            <Input
              aria-label={t("imageName")}
              placeholder={t("imageName")}
              className="font-mono"
              value={image.name}
              onChange={(e) => setRow("images", i, { name: e.target.value })}
            />
            <Input
              aria-label={t("dockerfile")}
              placeholder={t("dockerfile")}
              className="font-mono"
              value={image.dockerfile}
              onChange={(e) =>
                setRow("images", i, { dockerfile: e.target.value })
              }
            />
            <Input
              aria-label={t("context")}
              placeholder={t("context")}
              className="font-mono"
              value={image.context}
              onChange={(e) => setRow("images", i, { context: e.target.value })}
            />
          </RowFields>
        ))}
        <AddRow
          label={t("addImage")}
          onClick={() =>
            onChange((s) => ({
              ...s,
              images: [...s.images, { name: "", dockerfile: "", context: "." }],
            }))
          }
        />
        {issues.get(`${path}.images`) && (
          <FieldError>{issues.get(`${path}.images`)}</FieldError>
        )}
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">{t("bundleFiles")}</FieldLegend>
        <FieldDescription>{t("bundleFilesDescription")}</FieldDescription>
        {spec.bundleFiles.map((file, i) => (
          <RowFields
            key={i}
            onRemove={
              spec.bundleFiles.length > 1
                ? () => removeRow("bundleFiles", i)
                : undefined
            }
            error={issueAt(issues, `${path}.bundleFiles.${i}`)}
          >
            <Input
              aria-label={t("fileFrom")}
              placeholder={t("fileFrom")}
              className="font-mono"
              value={file.from}
              onChange={(e) =>
                setRow("bundleFiles", i, { from: e.target.value })
              }
            />
            <Input
              aria-label={t("fileTo")}
              placeholder={t("fileTo")}
              className="font-mono"
              value={file.to}
              onChange={(e) => setRow("bundleFiles", i, { to: e.target.value })}
            />
          </RowFields>
        ))}
        <AddRow
          label={t("addFile")}
          onClick={() =>
            onChange((s) => ({
              ...s,
              bundleFiles: [...s.bundleFiles, { from: "", to: "" }],
            }))
          }
        />
        {issues.get(`${path}.bundleFiles`) && (
          <FieldError>{issues.get(`${path}.bundleFiles`)}</FieldError>
        )}
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">{t("checks")}</FieldLegend>
        <FieldDescription>{t("checksDescription")}</FieldDescription>
        {spec.checks.map((check, i) => (
          <RowFields
            key={i}
            onRemove={() => removeRow("checks", i)}
            error={issueAt(issues, `${path}.checks.${i}`)}
          >
            <div className="flex flex-1 flex-col gap-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  aria-label={t("checkName")}
                  placeholder={t("checkName")}
                  className="font-mono"
                  value={check.name}
                  onChange={(e) =>
                    setRow("checks", i, { name: e.target.value })
                  }
                />
                <Input
                  aria-label={t("checkImage")}
                  placeholder={t("checkImage")}
                  className="font-mono"
                  value={check.image}
                  onChange={(e) =>
                    setRow("checks", i, { image: e.target.value })
                  }
                />
                <Input
                  aria-label={t("checkDir")}
                  placeholder={t("checkDir")}
                  className="font-mono"
                  value={check.dir}
                  onChange={(e) => setRow("checks", i, { dir: e.target.value })}
                />
              </div>
              <Textarea
                aria-label={t("checkCommands")}
                placeholder={t("checkCommands")}
                className="font-mono text-xs"
                rows={3}
                value={check.commands}
                onChange={(e) =>
                  setRow("checks", i, { commands: e.target.value })
                }
              />
            </div>
          </RowFields>
        ))}
        <AddRow
          label={t("addCheck")}
          onClick={() =>
            onChange((s) => ({
              ...s,
              checks: [
                ...s.checks,
                { name: "", image: "", dir: ".", commands: "" },
              ],
            }))
          }
        />
        {issues.get(`${path}.checks`) && (
          <FieldError>{issues.get(`${path}.checks`)}</FieldError>
        )}
      </FieldSet>

      <PipelinePreview componentKey={componentKey} spec={spec} />
    </div>
  );
}

function RowFields({
  children,
  onRemove,
  error,
}: {
  children: React.ReactNode;
  onRemove?: () => void;
  error?: string;
}) {
  const t = useTranslations("appForm");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-wrap gap-2 sm:flex-nowrap">
          {children}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={!onRemove}
          aria-label={t("removeRow")}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="self-start"
      onClick={onClick}
    >
      <Plus className="size-4" />
      {label}
    </Button>
  );
}

/** The YAML the Panel will serve for this spec, rendered by the server. */
function PipelinePreview({
  componentKey,
  spec,
}: {
  componentKey: string;
  spec: SpecDraft;
}) {
  const t = useTranslations("appForm");
  // Typing should not send a request per key stroke.
  const [debounced, setDebounced] = useState(spec);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(spec), 400);
    return () => clearTimeout(timer);
  }, [spec]);

  const parsed = buildSpecSchema.safeParse(toSpec(debounced));
  const ready =
    parsed.success && /^[a-z0-9][a-z0-9-]{0,63}$/.test(componentKey);
  const preview = useQuery(
    pipelinePreviewQuery(
      componentKey,
      ready ? (parsed.data as BuildSpec) : null
    )
  );

  return (
    <Field>
      <FieldLabel>{t("preview")}</FieldLabel>
      {!ready && !preview.data ? (
        <p className="text-sm text-muted-foreground">
          {t("previewIncomplete")}
        </p>
      ) : preview.isError ? (
        <p className="text-sm text-destructive">
          {preview.error instanceof ApiError
            ? preview.error.message
            : t("previewFailed")}
        </p>
      ) : (
        <pre
          className={cn(
            "max-h-96 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs",
            (!ready || preview.isFetching) && "opacity-60"
          )}
        >
          {preview.data?.yaml ?? t("previewLoading")}
        </pre>
      )}
    </Field>
  );
}
