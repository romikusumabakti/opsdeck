import {
  CircleUser,
  FolderKanban,
  ListTree,
  type LucideIcon,
  Server,
  Tag,
} from "lucide-react";
import type * as React from "react";
import { useTranslations } from "use-intl";
import type { PickerTrigger } from "@/components/compact-trigger";
import {
  type AssignableUser,
  AssigneeSelect,
  type IssueType,
  PRIORITY_DOT,
  type Priority,
  PrioritySelect,
  STATUS_DOT,
  type Status,
  StatusSelect,
  TypeIcon,
  TypeSelect,
} from "@/components/issues-board";
import { LabelChips, LabelPicker } from "@/components/label-ui";
import { SearchSelect } from "@/components/search-select";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import type { LabelLite } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

/**
 * Issue properties drawn two ways around the existing pickers (whose lists and
 * behaviour stay theirs): `chip` — a small pill for the New issue dialog's
 * chip row, showing the value or, when empty, the property's name; `row` — a
 * label/value line for the issue page's properties sidebar, showing the value
 * or its "none" wording. With `readOnly` (the caller may not change it) the
 * value is plain text and no picker exists.
 */
export type PropertyVariant = "chip" | "row";

type Common = { variant: PropertyVariant; readOnly?: boolean };

const CHIP = "max-w-60 font-normal";
const ROW = "w-full min-w-0 justify-start font-normal";

function triggerElement(variant: PropertyVariant): React.ReactElement {
  return variant === "chip" ? (
    <Button type="button" variant="outline" size="xs" className={CHIP} />
  ) : (
    <Button type="button" variant="ghost" size="sm" className={ROW} />
  );
}

/** What a trigger shows: the icon, then the value (named for screen readers)
 *  or the empty wording. */
function PropertyContent({
  variant,
  label,
  emptyLabel,
  icon,
  value,
}: {
  variant: PropertyVariant;
  label: string;
  emptyLabel: string;
  icon?: React.ReactNode;
  value: React.ReactNode | null;
}) {
  if (value === null) {
    return (
      <>
        {icon}
        <span className="truncate text-muted-foreground">
          {variant === "chip" ? label : emptyLabel}
        </span>
        {variant === "row" ? <span className="sr-only">: {label}</span> : null}
      </>
    );
  }
  return (
    <>
      {icon}
      <span className="sr-only">{label}: </span>
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        {value}
      </span>
    </>
  );
}

function PropertyShell({
  variant,
  readOnly,
  label,
  content,
  picker,
}: Common & {
  label: string;
  content: React.ReactNode;
  picker: (trigger: PickerTrigger) => React.ReactNode;
}) {
  const body = readOnly ? (
    <span
      data-slot="issue-property"
      data-readonly=""
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-sm",
        variant === "chip"
          ? "h-6 max-w-60 rounded-[min(var(--radius-md),8px)] border px-2 text-xs"
          : "h-8 px-2.5"
      )}
    >
      {content}
    </span>
  ) : (
    picker({ render: triggerElement(variant), content })
  );
  if (variant === "chip") return body;
  // The trigger names the property itself (sr-only), so the visible label is
  // not read twice.
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
      <span aria-hidden className="truncate text-sm text-muted-foreground">
        {label}
      </span>
      {body}
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", className)} />;
}

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="text-muted-foreground" aria-hidden />;
}

export function StatusProperty({
  value,
  onChange,
  ...common
}: Common & { value: Status; onChange: (s: Status) => void }) {
  const t = useTranslations("issues");
  const label = t("columnStatus");
  const content = (
    <PropertyContent
      variant={common.variant}
      label={label}
      emptyLabel={label}
      icon={<Dot className={STATUS_DOT[value]} />}
      value={t(`status.${value}`)}
    />
  );
  return (
    <PropertyShell
      {...common}
      label={label}
      content={content}
      picker={(trigger) => (
        <StatusSelect value={value} onChange={onChange} trigger={trigger} />
      )}
    />
  );
}

export function PriorityProperty({
  value,
  onChange,
  ...common
}: Common & { value: Priority; onChange: (p: Priority) => void }) {
  const t = useTranslations("issues");
  const label = t("priorityLabel");
  const content = (
    <PropertyContent
      variant={common.variant}
      label={label}
      emptyLabel={label}
      icon={<Dot className={PRIORITY_DOT[value]} />}
      value={t(`priority.${value}`)}
    />
  );
  return (
    <PropertyShell
      {...common}
      label={label}
      content={content}
      picker={(trigger) => (
        <PrioritySelect value={value} onChange={onChange} trigger={trigger} />
      )}
    />
  );
}

export function TypeProperty({
  value,
  onChange,
  ...common
}: Common & { value: IssueType; onChange: (v: IssueType) => void }) {
  const t = useTranslations("issues");
  const label = t("typeLabel");
  const content = (
    <PropertyContent
      variant={common.variant}
      label={label}
      emptyLabel={label}
      icon={
        <span aria-hidden className="contents">
          <TypeIcon type={value} />
        </span>
      }
      value={t(`type.${value}`)}
    />
  );
  return (
    <PropertyShell
      {...common}
      label={label}
      content={content}
      picker={(trigger) => (
        <TypeSelect value={value} onChange={onChange} trigger={trigger} />
      )}
    />
  );
}

export function AssigneeProperty({
  users,
  value,
  onChange,
  ...common
}: Common & {
  users: AssignableUser[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useTranslations("issues");
  const label = t("assignee");
  const person = value ? users.find((u) => u.id === value) : undefined;
  const content = (
    <PropertyContent
      variant={common.variant}
      label={label}
      emptyLabel={t("unassigned")}
      icon={
        person ? (
          <UserAvatar
            user={{ id: person.id, name: person.name, image: person.image }}
            size="xs"
          />
        ) : (
          <Glyph icon={CircleUser} />
        )
      }
      value={person ? person.name : null}
    />
  );
  return (
    <PropertyShell
      {...common}
      label={label}
      content={content}
      picker={(trigger) => (
        <AssigneeSelect
          users={users}
          value={value}
          onChange={onChange}
          trigger={trigger}
        />
      )}
    />
  );
}

export function LabelsProperty({
  allLabels,
  value,
  onChange,
  ...common
}: Common & {
  allLabels: LabelLite[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations("issueDetail");
  const label = t("labels");
  const selected = allLabels.filter((l) => value.includes(l.id));
  const content = (
    <PropertyContent
      variant={common.variant}
      label={label}
      emptyLabel={t("noLabels")}
      icon={selected.length === 0 ? <Glyph icon={Tag} /> : undefined}
      value={
        selected.length > 0 ? (
          <LabelChips
            labels={selected}
            max={3}
            className="inline-flex min-w-0 items-center gap-1"
          />
        ) : null
      }
    />
  );
  return (
    <PropertyShell
      {...common}
      label={label}
      content={content}
      picker={(trigger) => (
        <LabelPicker
          allLabels={allLabels}
          selected={value}
          onChange={onChange}
          trigger={trigger}
        />
      )}
    />
  );
}

/** A searchable one-of property (environment, parent, project). */
function SearchProperty({
  label,
  emptyLabel,
  icon,
  options,
  value,
  onChange,
  noneLabel,
  ...common
}: Common & {
  label: string;
  emptyLabel: string;
  icon: LucideIcon;
  options: { value: string; label: string; keywords?: string }[];
  value: string | null;
  onChange: (v: string | null) => void;
  /** Offers "none" in the list; omitted when a value is required. */
  noneLabel?: string;
}) {
  const option = value ? options.find((o) => o.value === value) : undefined;
  const content = (
    <PropertyContent
      variant={common.variant}
      label={label}
      emptyLabel={emptyLabel}
      icon={<Glyph icon={icon} />}
      value={option ? option.label : null}
    />
  );
  return (
    <PropertyShell
      {...common}
      label={label}
      content={content}
      picker={(trigger) => (
        <SearchSelect
          value={value}
          onChange={onChange}
          options={options}
          placeholder={label}
          noneLabel={noneLabel}
          trigger={trigger}
        />
      )}
    />
  );
}

export function EnvironmentProperty({
  environments,
  ...rest
}: Common & {
  environments: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useTranslations("issues");
  return (
    <SearchProperty
      {...rest}
      label={t("columnEnvironment")}
      emptyLabel={t("none")}
      noneLabel={t("none")}
      icon={Server}
      options={environments.map((e) => ({ value: e.id, label: e.name }))}
    />
  );
}

/** `KEY-12 · Title`, or `#12 · Title` without a project key. */
export function parentOptionLabel(
  parent: { number: number; title: string },
  projectKey?: string
) {
  const ref = projectKey
    ? `${projectKey}-${parent.number}`
    : `#${parent.number}`;
  return `${ref} · ${parent.title}`;
}

export function ParentProperty({
  parents,
  projectKey,
  ...rest
}: Common & {
  parents: { id: string; number: number; title: string }[];
  projectKey?: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useTranslations("issueDetail");
  return (
    <SearchProperty
      {...rest}
      label={t("parent")}
      emptyLabel={t("noParent")}
      noneLabel={t("noParent")}
      icon={ListTree}
      options={parents.map((p) => ({
        value: p.id,
        label: parentOptionLabel(p, projectKey),
        keywords: String(p.number),
      }))}
    />
  );
}

export function ProjectProperty({
  projects,
  value,
  onChange,
  ...common
}: Common & {
  projects: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useTranslations("issues");
  return (
    <SearchProperty
      {...common}
      label={t("project")}
      emptyLabel={t("project")}
      icon={FolderKanban}
      options={projects.map((p) => ({ value: p.id, label: p.name }))}
      value={value}
      onChange={(v) => {
        if (v) onChange(v);
      }}
    />
  );
}
