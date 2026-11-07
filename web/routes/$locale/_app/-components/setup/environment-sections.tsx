import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type DatabaseDraft,
  type DomainDraft,
  type DraftContext,
  defaultDatabaseName,
  defaultDbContainer,
  defaultDeployDir,
  type EnvironmentDraft,
  effectiveServices,
  PUBLIC_POLICY,
  type TargetDraft,
  type VariableDraft,
  type VariableKind,
  variableHandling,
  withPasswordVariable,
} from "@/lib/setup/draft";
import type { SetupServiceRole } from "@/lib/setup/schema";
import { type SectionName, sectionOfField } from "@/lib/setup/sections";
import type { DatabaseHostRow } from "@/web/api/database-hosts";
import type { SetupOptions } from "@/web/api/setup";
import { useIssueMessage } from "./use-issue-message";

/**
 * The sections both setup flows share (Add environment, and the New app
 * stepper's steps): server, database, variables, domain and deploy. They are
 * controlled by an `EnvironmentDraft` and show the preview's issues inline,
 * next to the field each one is about (`issues` maps a field path to a code).
 */
export type SectionsProps = {
  draft: EnvironmentDraft;
  onChange: (update: (draft: EnvironmentDraft) => EnvironmentDraft) => void;
  draftCtx: DraftContext;
  options: SetupOptions | undefined;
  databaseHosts: DatabaseHostRow[];
  /** The Access policies; undefined while loading or when unavailable. */
  policies: { id: string; name: string }[] | undefined;
  policiesFailed: boolean;
  /** May bind a policy-less (public) hostname: org server:manage. */
  canPublish: boolean;
  /** Issue code by field path. */
  issues: Record<string, string>;
};

function issueCount(issues: Record<string, string>, section: SectionName) {
  return Object.keys(issues).filter((f) => sectionOfField(f) === section)
    .length;
}

function SectionShell({
  title,
  summary,
  issues,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary: React.ReactNode;
  issues: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("setupWizard");
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-card"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-start outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
        )}
        <span className="text-sm font-medium">{title}</span>
        {issues > 0 && (
          <Badge variant="destructive">
            {t("sections.issueCount", { count: issues })}
          </Badge>
        )}
        {!open && (
          <span className="ms-auto min-w-0 truncate text-sm text-muted-foreground">
            {summary}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 border-t px-4 py-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A labelled control with the issue for its field under it. */
function FieldRow({
  label,
  hint,
  field,
  issues,
  projectKey,
  htmlFor,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  field: string;
  issues: Record<string, string>;
  projectKey: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const message = useIssueMessage(projectKey);
  const code = issues[field];
  return (
    <Field data-invalid={code ? true : undefined}>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      <FieldContent>
        {children}
        {hint && <FieldDescription>{hint}</FieldDescription>}
        {code && <FieldError>{message(code)}</FieldError>}
      </FieldContent>
    </Field>
  );
}

/** Only the issue of a field, for a control that has no label of its own. */
function IssueText({
  field,
  issues,
  projectKey,
}: {
  field: string;
  issues: Record<string, string>;
  projectKey: string;
}) {
  const message = useIssueMessage(projectKey);
  const code = issues[field];
  return code ? <FieldError>{message(code)}</FieldError> : null;
}

type Patch<T> = (patch: Partial<T>) => void;

function useSectionPatches(props: SectionsProps) {
  const { onChange } = props;
  return {
    patchDraft: (patch: Partial<EnvironmentDraft>) =>
      onChange((d) => ({ ...d, ...patch })),
    patchDatabase: ((patch) =>
      onChange((d) => {
        const next = { ...d, database: { ...d.database, ...patch } };
        // Choosing a shared database adds its password variable; renaming
        // the variable later does not add a row per keystroke.
        return "kind" in patch ? withPasswordVariable(next) : next;
      })) as Patch<DatabaseDraft>,
    patchDomain: ((patch) =>
      onChange((d) => ({
        ...d,
        domain: { ...d.domain, ...patch },
      }))) as Patch<DomainDraft>,
    patchTarget: (index: number, patch: Partial<TargetDraft>) =>
      onChange((d) => ({
        ...d,
        targets: d.targets.map((t, i) =>
          i === index ? { ...t, ...patch } : t
        ),
      })),
    patchVariable: (key: string, patch: Partial<VariableDraft>) =>
      onChange((d) => ({
        ...d,
        variables: d.variables.map((v) =>
          v.key === key ? { ...v, ...patch } : v
        ),
      })),
  };
}

export function EnvironmentSections(props: SectionsProps) {
  return (
    <div className="flex flex-col gap-3">
      <ServerSection {...props} defaultOpen />
      <DatabaseSection {...props} />
      <VariablesSection {...props} />
      <DomainSection {...props} />
      <DeploySection {...props} />
    </div>
  );
}

export function ServerSection(
  props: SectionsProps & { defaultOpen?: boolean }
) {
  const { draft, draftCtx, options, issues, defaultOpen } = props;
  const t = useTranslations("setupWizard");
  const { patchDraft } = useSectionPatches(props);
  const { onChange } = props;
  const servers = options?.servers ?? [];
  const server = servers.find((s) => s.id === draft.serverId);
  const services = effectiveServices(draft, draftCtx);

  return (
    <SectionShell
      title={t("sections.server")}
      issues={issueCount(issues, "server")}
      defaultOpen={defaultOpen}
      summary={
        server
          ? t("server.summary", { server: server.name, count: services.length })
          : t("server.summaryNone")
      }
    >
      <FieldRow
        label={t("server.label")}
        field="server.serverId"
        issues={issues}
        projectKey={draftCtx.projectKey}
        hint={servers.length === 0 ? t("server.none") : undefined}
      >
        <Select
          value={draft.serverId || null}
          onValueChange={(value) => patchDraft({ serverId: value ?? "" })}
          disabled={servers.length === 0}
        >
          <SelectTrigger aria-label={t("server.label")}>
            <SelectValue placeholder={t("server.placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name} ({s.host})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <div className="flex flex-col gap-3">
        <div>
          <h4 className="text-sm font-medium">{t("server.containers")}</h4>
          <p className="text-sm text-muted-foreground">
            {t("server.containersHint")}
          </p>
        </div>
        {services.length === 0 && (
          <FieldRow
            label={t("server.role.backend")}
            field="services"
            issues={issues}
            projectKey={draftCtx.projectKey}
          >
            <p className="text-sm text-muted-foreground">
              {t("server.noContainers")}
            </p>
          </FieldRow>
        )}
        {services.map(({ role, serviceName }) => (
          <FieldRow
            key={role}
            label={t(`server.role.${role}`)}
            field={`services.${role}`}
            issues={issues}
            projectKey={draftCtx.projectKey}
            htmlFor={`service-${role}`}
          >
            <Input
              id={`service-${role}`}
              className="font-mono"
              autoComplete="off"
              value={serviceName}
              aria-invalid={issues[`services.${role}`] ? true : undefined}
              onChange={(e) =>
                onChange((d) => ({
                  ...d,
                  serviceNames: {
                    ...d.serviceNames,
                    [role]: e.target.value.trim(),
                  } as Partial<Record<SetupServiceRole, string>>,
                }))
              }
            />
          </FieldRow>
        ))}
      </div>
    </SectionShell>
  );
}

const DB_KINDS = ["shared", "container", "external", "none"] as const;

export function DatabaseSection(
  props: SectionsProps & { defaultOpen?: boolean }
) {
  const { draft, draftCtx, databaseHosts, issues, defaultOpen } = props;
  const t = useTranslations("setupWizard");
  const { patchDatabase } = useSectionPatches(props);
  const db = draft.database;
  const hosts = databaseHosts.filter((h) => h.serverId === draft.serverId);
  const key = draftCtx.projectKey;

  const summary =
    db.kind === "shared"
      ? t("database.summaryShared", {
          name: db.dbName ?? defaultDatabaseName(draftCtx),
        })
      : db.kind === "container"
        ? t("database.summaryContainer", {
            name: db.serviceName ?? defaultDbContainer(draft, draftCtx),
          })
        : t(`database.summary_${db.kind}`);

  return (
    <SectionShell
      title={t("sections.database")}
      issues={issueCount(issues, "database")}
      defaultOpen={defaultOpen}
      summary={summary}
    >
      <FieldRow
        label={t("database.kind")}
        field="database.kind"
        issues={issues}
        projectKey={key}
      >
        <Select
          value={db.kind}
          onValueChange={(value) =>
            patchDatabase({ kind: (value ?? "none") as DatabaseDraft["kind"] })
          }
        >
          <SelectTrigger aria-label={t("database.kind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DB_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`database.kind_${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {db.kind === "shared" && (
        <>
          <FieldRow
            label={t("database.host")}
            field="database.databaseHostId"
            issues={issues}
            projectKey={key}
            hint={
              hosts.length === 0 && draft.serverId
                ? t("database.noHosts")
                : undefined
            }
          >
            <Select
              value={db.databaseHostId || null}
              onValueChange={(value) =>
                patchDatabase({ databaseHostId: value ?? "" })
              }
              disabled={hosts.length === 0}
            >
              <SelectTrigger aria-label={t("database.host")}>
                <SelectValue placeholder={t("database.hostPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {hosts.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.label} ({h.containerName})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow
              label={t("database.dbName")}
              field="database.dbName"
              issues={issues}
              projectKey={key}
              htmlFor="db-name"
            >
              <Input
                id="db-name"
                className="font-mono"
                autoComplete="off"
                value={db.dbName ?? defaultDatabaseName(draftCtx)}
                onChange={(e) => patchDatabase({ dbName: e.target.value })}
              />
            </FieldRow>
            <FieldRow
              label={t("database.dbRole")}
              field="database.dbRole"
              issues={issues}
              projectKey={key}
              htmlFor="db-role"
            >
              <Input
                id="db-role"
                className="font-mono"
                autoComplete="off"
                value={db.dbRole ?? defaultDatabaseName(draftCtx)}
                onChange={(e) => patchDatabase({ dbRole: e.target.value })}
              />
            </FieldRow>
          </div>
          <FieldRow
            label={t("database.passwordVariable")}
            field="database.passwordVariable"
            issues={issues}
            projectKey={key}
            htmlFor="db-password-variable"
          >
            <Input
              id="db-password-variable"
              className="font-mono"
              autoComplete="off"
              value={db.passwordVariable}
              onChange={(e) =>
                patchDatabase({ passwordVariable: e.target.value })
              }
            />
          </FieldRow>
        </>
      )}

      {db.kind === "container" && (
        <FieldRow
          label={t("database.containerName")}
          field="database.serviceName"
          issues={issues}
          projectKey={key}
          htmlFor="db-container"
        >
          <Input
            id="db-container"
            className="font-mono"
            autoComplete="off"
            value={db.serviceName ?? defaultDbContainer(draft, draftCtx)}
            onChange={(e) => patchDatabase({ serviceName: e.target.value })}
          />
        </FieldRow>
      )}
    </SectionShell>
  );
}

const VARIABLE_KINDS: VariableKind[] = ["plain", "secret", "generated"];

export function VariablesSection(
  props: SectionsProps & { defaultOpen?: boolean }
) {
  const { draft, draftCtx, issues, defaultOpen, onChange } = props;
  const t = useTranslations("setupWizard");
  const message = useIssueMessage(draftCtx.projectKey);
  const { patchVariable } = useSectionPatches(props);
  const counter = React.useRef(0);

  function add() {
    counter.current += 1;
    onChange((d) => ({
      ...d,
      variables: [
        ...d.variables,
        {
          key: `new-${counter.current}`,
          name: "",
          kind: "plain",
          escrow: false,
          fromSource: false,
          copyable: false,
          value: "",
          required: false,
        },
      ],
    }));
  }

  const generated = draft.variables.filter((v) => v.kind === "generated");
  return (
    <SectionShell
      title={t("sections.variables")}
      issues={issueCount(issues, "variables")}
      defaultOpen={defaultOpen}
      summary={
        draft.variables.length === 0
          ? t("variables.summaryNone")
          : t("variables.summary", {
              count: draft.variables.length,
              generated: generated.length,
            })
      }
    >
      {draft.variables.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("variables.empty")}</p>
      )}
      <ul className="flex flex-col gap-3">
        {draft.variables.map((v) => {
          const handling = variableHandling(v);
          const code = issues[`variables.${v.name}`];
          return (
            <li
              key={v.key}
              className="flex flex-col gap-2 rounded-md border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                {v.fromSource ? (
                  <code className="font-mono text-sm">{v.name}</code>
                ) : (
                  <Input
                    className="max-w-64 font-mono"
                    autoComplete="off"
                    placeholder={t("variables.namePlaceholder")}
                    aria-label={t("variables.name")}
                    value={v.name}
                    onChange={(e) =>
                      patchVariable(v.key, {
                        name: e.target.value.toUpperCase(),
                      })
                    }
                  />
                )}
                {v.fromSource || (
                  <Select
                    value={v.kind}
                    onValueChange={(value) =>
                      patchVariable(v.key, {
                        kind: (value ?? "plain") as VariableKind,
                        required: value === "secret",
                      })
                    }
                  >
                    <SelectTrigger
                      className="w-36"
                      aria-label={t("variables.kind")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VARIABLE_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`variables.kind_${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {v.fromSource && (
                  <Badge variant="outline">
                    {t(`variables.kind_${v.kind}`)}
                  </Badge>
                )}
                {v.escrow && (
                  <Badge variant="secondary">{t("variables.escrowed")}</Badge>
                )}
                {v.fromSource || (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="ms-auto"
                    aria-label={t("variables.remove")}
                    onClick={() =>
                      onChange((d) => ({
                        ...d,
                        variables: d.variables.filter((x) => x.key !== v.key),
                      }))
                    }
                  >
                    <X />
                  </Button>
                )}
              </div>
              {handling === "generate" && (
                <p className="text-sm text-muted-foreground">
                  {t("variables.handling_generate")}
                </p>
              )}
              {handling === "copy" && (
                <p className="text-sm text-muted-foreground">
                  {t("variables.handling_copy")}
                </p>
              )}
              {handling === "enter" &&
                (v.kind === "secret" ? (
                  <PasswordInput
                    autoComplete="new-password"
                    aria-label={t("variables.value", { name: v.name })}
                    placeholder={t("variables.handling_enter")}
                    value={v.value}
                    aria-invalid={code ? true : undefined}
                    onChange={(e) =>
                      patchVariable(v.key, { value: e.target.value })
                    }
                  />
                ) : (
                  <Input
                    className="font-mono"
                    autoComplete="off"
                    aria-label={t("variables.value", { name: v.name })}
                    placeholder={
                      v.required ? t("variables.handling_enter") : undefined
                    }
                    value={v.value}
                    aria-invalid={code ? true : undefined}
                    onChange={(e) =>
                      patchVariable(v.key, { value: e.target.value })
                    }
                  />
                ))}
              {code && <FieldError>{message(code)}</FieldError>}
            </li>
          );
        })}
      </ul>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus data-icon="inline-start" />
          {t("variables.add")}
        </Button>
      </div>
    </SectionShell>
  );
}

const DOMAIN_KINDS = ["none", "tunnel", "external"] as const;

export function DomainSection(
  props: SectionsProps & { defaultOpen?: boolean }
) {
  const {
    draft,
    draftCtx,
    options,
    policies,
    policiesFailed,
    canPublish,
    issues,
    defaultOpen,
  } = props;
  const t = useTranslations("setupWizard");
  const td = useTranslations("domains");
  const { patchDomain } = useSectionPatches(props);
  const d = draft.domain;
  const key = draftCtx.projectKey;
  const zones = options?.zones ?? [];
  const zoneId = d.zoneId || draftCtx.defaultZoneId;
  const zone = zones.find((z) => z.id === zoneId);
  const suggested = draftCtx.suggestedEntryPort;

  const summary =
    d.kind === "tunnel"
      ? `${d.label ?? draftCtx.slug}${zone ? `.${zone.name}` : ""}`
      : d.kind === "external"
        ? d.hostname || td("kind_external")
        : td("kind_none");

  return (
    <SectionShell
      title={t("sections.domain")}
      issues={issueCount(issues, "domain")}
      defaultOpen={defaultOpen}
      summary={summary}
    >
      <FieldRow
        label={td("kind")}
        field="domain.kind"
        issues={issues}
        projectKey={key}
      >
        <Select
          value={d.kind}
          onValueChange={(value) =>
            patchDomain({ kind: (value ?? "none") as DomainDraft["kind"] })
          }
        >
          <SelectTrigger aria-label={td("kind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DOMAIN_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {td(`kind_${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {d.kind === "tunnel" && (
        <>
          <FieldRow
            label={td("zone")}
            field="domain.zoneId"
            issues={issues}
            projectKey={key}
          >
            <Select
              value={zoneId || null}
              onValueChange={(value) => patchDomain({ zoneId: value ?? "" })}
              disabled={zones.length === 0}
            >
              <SelectTrigger aria-label={td("zone")}>
                <SelectValue
                  placeholder={
                    zones.length === 0 ? td("noZones") : td("zonePlaceholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    {z.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow
            label={td("label")}
            field="domain.label"
            issues={issues}
            projectKey={key}
            htmlFor="domain-label"
            hint={td("labelHint")}
          >
            <Input
              id="domain-label"
              className="font-mono"
              autoComplete="off"
              value={d.label ?? draftCtx.slug}
              onChange={(e) =>
                patchDomain({ label: e.target.value.toLowerCase() })
              }
            />
          </FieldRow>
          <FieldRow
            label={td("entryPort")}
            field="domain.entryPort"
            issues={issues}
            projectKey={key}
            htmlFor="domain-port"
            hint={
              d.entryPort === null
                ? suggested === null
                  ? t("domain.entryPortNoPreflight")
                  : t("domain.entryPortSuggested")
                : td("entryPortDescription")
            }
          >
            <Input
              id="domain-port"
              className="max-w-40 font-mono"
              inputMode="numeric"
              autoComplete="off"
              value={d.entryPort ?? suggested?.toString() ?? ""}
              onChange={(e) =>
                patchDomain({ entryPort: e.target.value.trim() })
              }
            />
          </FieldRow>
          <FieldRow
            label={td("accessPolicy")}
            field="domain.accessPolicyId"
            issues={issues}
            projectKey={key}
            hint={td("accessPolicyDescription")}
          >
            <Select
              value={d.accessPolicyId || null}
              onValueChange={(value) =>
                patchDomain({ accessPolicyId: value ?? "" })
              }
            >
              <SelectTrigger aria-label={td("accessPolicy")}>
                <SelectValue placeholder={td("policyPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {canPublish && (
                  <SelectItem value={PUBLIC_POLICY}>{td("public")}</SelectItem>
                )}
                {(policies ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {policiesFailed && (
              <Alert variant="destructive">
                <AlertDescription>{td("policiesFailed")}</AlertDescription>
              </Alert>
            )}
          </FieldRow>
        </>
      )}

      {d.kind === "external" && (
        <FieldRow
          label={td("hostname")}
          field="domain.hostname"
          issues={issues}
          projectKey={key}
          htmlFor="domain-hostname"
          hint={td("hostnameDescription")}
        >
          <Input
            id="domain-hostname"
            className="font-mono"
            autoComplete="off"
            value={d.hostname}
            onChange={(e) =>
              patchDomain({ hostname: e.target.value.trim().toLowerCase() })
            }
          />
        </FieldRow>
      )}
    </SectionShell>
  );
}

export function DeploySection(
  props: SectionsProps & { defaultOpen?: boolean }
) {
  const { draft, draftCtx, issues, defaultOpen } = props;
  const t = useTranslations("setupWizard");
  const tf = useTranslations("deploys.form");
  const { patchTarget } = useSectionPatches(props);
  const key = draftCtx.projectKey;

  return (
    <SectionShell
      title={t("sections.deploy")}
      issues={issueCount(issues, "deploy")}
      defaultOpen={defaultOpen}
      summary={draft.targets
        .map((target) => `${target.componentKey} ← ${target.sourceBranch}`)
        .join(", ")}
    >
      <IssueText field="targets" issues={issues} projectKey={key} />
      {draft.targets.map((target, i) => {
        const field = (name: string) => `targets.${i}.${name}`;
        const id = (name: string) => `target-${i}-${name}`;
        return (
          <fieldset
            key={target.componentKey}
            className="flex flex-col gap-4 rounded-md border p-3"
          >
            <legend className="px-1 font-mono text-sm">
              {target.componentKey}
            </legend>
            <FieldRow
              label={tf("sourceBranch")}
              field={field("sourceBranch")}
              issues={issues}
              projectKey={key}
              htmlFor={id("branch")}
            >
              <Input
                id={id("branch")}
                className="font-mono"
                autoComplete="off"
                value={target.sourceBranch}
                onChange={(e) =>
                  patchTarget(i, { sourceBranch: e.target.value.trim() })
                }
              />
            </FieldRow>
            <FieldRow
              label={tf("deployDir")}
              field={field("deployDir")}
              issues={issues}
              projectKey={key}
              htmlFor={id("dir")}
              hint={tf("deployDirHint")}
            >
              <Input
                id={id("dir")}
                className="font-mono"
                autoComplete="off"
                value={target.deployDir ?? defaultDeployDir(draftCtx)}
                onChange={(e) =>
                  patchTarget(i, { deployDir: e.target.value.trim() })
                }
              />
            </FieldRow>
            <FieldRow
              label={tf("services")}
              field={field("services")}
              issues={issues}
              projectKey={key}
              htmlFor={id("services")}
              hint={tf("servicesHint")}
            >
              <Input
                id={id("services")}
                className="font-mono"
                autoComplete="off"
                value={target.services}
                onChange={(e) => patchTarget(i, { services: e.target.value })}
              />
            </FieldRow>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow
                label={tf("tagVariable")}
                field={field("tagVariable")}
                issues={issues}
                projectKey={key}
                htmlFor={id("tag")}
              >
                <Input
                  id={id("tag")}
                  className="font-mono"
                  autoComplete="off"
                  value={target.tagVariable}
                  onChange={(e) =>
                    patchTarget(i, { tagVariable: e.target.value.trim() })
                  }
                />
              </FieldRow>
              <FieldRow
                label={tf("healthTimeoutSeconds")}
                field={field("healthTimeoutSeconds")}
                issues={issues}
                projectKey={key}
                htmlFor={id("timeout")}
              >
                <Input
                  id={id("timeout")}
                  inputMode="numeric"
                  autoComplete="off"
                  value={target.healthTimeoutSeconds}
                  onChange={(e) =>
                    patchTarget(i, {
                      healthTimeoutSeconds: e.target.value.trim(),
                    })
                  }
                />
              </FieldRow>
            </div>
            <FieldRow
              label={tf("healthUrl")}
              field={field("healthUrl")}
              issues={issues}
              projectKey={key}
              htmlFor={id("health")}
              hint={tf("healthUrlHint")}
            >
              <Input
                id={id("health")}
                className="font-mono"
                autoComplete="off"
                value={target.healthUrl}
                onChange={(e) =>
                  patchTarget(i, { healthUrl: e.target.value.trim() })
                }
              />
            </FieldRow>
            <FieldRow
              label={tf("preStartCommand")}
              field={field("preStartCommand")}
              issues={issues}
              projectKey={key}
              htmlFor={id("prestart")}
              hint={tf("preStartCommandHint")}
            >
              <Input
                id={id("prestart")}
                className="font-mono"
                autoComplete="off"
                value={target.preStartCommand}
                onChange={(e) =>
                  patchTarget(i, { preStartCommand: e.target.value })
                }
              />
            </FieldRow>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={id("auto")}
                  checked={target.autoDeploy}
                  onCheckedChange={(checked) =>
                    patchTarget(i, { autoDeploy: checked === true })
                  }
                />
                <Label htmlFor={id("auto")} className="font-normal">
                  {tf("autoDeploy")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={id("backup")}
                  checked={target.backupBeforeDeploy}
                  onCheckedChange={(checked) =>
                    patchTarget(i, { backupBeforeDeploy: checked === true })
                  }
                />
                <Label htmlFor={id("backup")} className="font-normal">
                  {tf("backupBeforeDeploy")}
                </Label>
              </div>
              <IssueText
                field={field("backupBeforeDeploy")}
                issues={issues}
                projectKey={key}
              />
            </div>
          </fieldset>
        );
      })}
    </SectionShell>
  );
}
