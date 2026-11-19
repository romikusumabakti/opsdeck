import { useTranslations } from "use-intl";
import {
  AssigneeProperty,
  EnvironmentProperty,
  LabelsProperty,
  ParentProperty,
  PriorityProperty,
  type PropertyVariant,
  StatusProperty,
  TypeProperty,
} from "@/components/issue-property-trigger";
import type {
  AssignableUser,
  IssueType,
  Priority,
  Status,
} from "@/components/issues-board";
import { RelativeTime } from "@/components/relative-time";
import type { LabelLite } from "@/lib/db/schema";
import type { IssueDetail } from "@/web/api/issues";

/** A property change the page sends through its update queue. */
export type IssuePatch = {
  status?: Status;
  priority?: Priority;
  type?: IssueType;
  assigneeId?: string | null;
  environmentId?: string | null;
  parentId?: string | null;
};

type PropertiesProps = {
  issue: IssueDetail;
  readOnly: boolean;
  users: AssignableUser[];
  environments: { id: string; name: string }[];
  parentCandidates: { id: string; number: number; title: string }[];
  allLabels: LabelLite[];
  labelIds: string[];
  onPatch: (patch: IssuePatch) => void;
  onLabelsChange: (ids: string[]) => void;
};

/** The issue's properties as triggers of one variant, in the sidebar's
 *  order. Parent only when set or when there is something to pick. */
function PropertyList({
  variant,
  issue,
  readOnly,
  users,
  environments,
  parentCandidates,
  allLabels,
  labelIds,
  onPatch,
  onLabelsChange,
}: PropertiesProps & { variant: PropertyVariant }) {
  const common = { variant, readOnly };
  return (
    <>
      <StatusProperty
        {...common}
        value={issue.status as Status}
        onChange={(status) => onPatch({ status })}
      />
      <PriorityProperty
        {...common}
        value={issue.priority as Priority}
        onChange={(priority) => onPatch({ priority })}
      />
      <AssigneeProperty
        {...common}
        users={users}
        value={issue.assignee?.id ?? null}
        onChange={(assigneeId) => onPatch({ assigneeId })}
      />
      <TypeProperty
        {...common}
        value={issue.type as IssueType}
        onChange={(type) => onPatch({ type })}
      />
      <LabelsProperty
        {...common}
        allLabels={allLabels}
        value={labelIds}
        onChange={onLabelsChange}
      />
      <EnvironmentProperty
        {...common}
        environments={environments}
        value={issue.environment?.id ?? null}
        onChange={(environmentId) => onPatch({ environmentId })}
      />
      {parentCandidates.length > 0 || issue.parentId ? (
        <ParentProperty
          {...common}
          parents={parentCandidates}
          projectKey={issue.project.key}
          value={issue.parentId ?? null}
          onChange={(parentId) => onPatch({ parentId })}
        />
      ) : null}
    </>
  );
}

/** From `lg`: the properties sidebar, with the read-only dates. */
export function IssuePropertiesSidebar(props: PropertiesProps) {
  const t = useTranslations("issues");
  return (
    <aside
      aria-label={t("properties")}
      className="hidden min-w-0 flex-col gap-0.5 self-start lg:flex"
    >
      <PropertyList variant="row" {...props} />
      <div
        data-slot="issue-dates"
        className="mt-2 flex flex-col gap-0.5 border-t pt-2"
      >
        <DateRow label={t("columnCreated")} date={props.issue.createdAt} />
        <DateRow label={t("columnUpdated")} date={props.issue.updatedAt} />
      </div>
    </aside>
  );
}

/** Below `lg`: the same properties as a chip row under the title. */
export function IssuePropertyChips(props: PropertiesProps) {
  const t = useTranslations("issues");
  return (
    <div
      role="group"
      aria-label={t("properties")}
      className="flex flex-wrap items-center gap-1.5 lg:hidden"
    >
      <PropertyList variant="chip" {...props} />
    </div>
  );
}

/** Below `lg`: the sidebar's dates as one muted line under the chip row. */
export function IssueDatesLine({ issue }: { issue: PropertiesProps["issue"] }) {
  const t = useTranslations("issues");
  return (
    <p
      data-slot="issue-dates-inline"
      className="-mt-4 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground lg:hidden"
    >
      <span>
        {t("columnCreated")} <RelativeTime date={issue.createdAt} />
      </span>
      <span aria-hidden="true">·</span>
      <span className="sr-only">, </span>
      <span>
        {t("columnUpdated")} <RelativeTime date={issue.updatedAt} />
      </span>
    </p>
  );
}

function DateRow({ label, date }: { label: string; date: string | Date }) {
  return (
    <div className="grid h-8 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 text-sm">
      <span className="truncate text-muted-foreground">{label}</span>
      <RelativeTime date={date} className="truncate px-2.5" />
    </div>
  );
}
