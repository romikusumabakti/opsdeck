import { ChevronDown, TriangleAlert } from "lucide-react";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { VariableKind } from "@/lib/db/schema";
import {
  IMPORT_TEXT_MAX_BYTES,
  type ImportRow,
  type ImportSkipReason,
} from "@/lib/variables/import-rows";
import type { ImportReviewDir } from "@/web/api/variables";
import { VARIABLE_KINDS } from "./variable-form-dialog";

// The review half of "Import .env": the deploy dirs' status strip, the rows
// to pick from, and the collapsed groups of rows that need nothing.

/** Six dots whatever the value's length: the length is not disclosed. */
export const IMPORT_MASK = "••••••";

/** What the user picked for one reviewable row. */
export type ImportChoice = {
  selected: boolean;
  kind: VariableKind;
  /** The chosen dir's value, for a row the dirs disagree on. */
  valueId?: string;
};

export type ImportChoices = Record<string, ImportChoice>;

export function hasFlags(row: ImportRow): boolean {
  const { differsAcrossDirs, unresolvedRefs, duplicate } = row.flags;
  return Boolean(differsAcrossDirs || unresolvedRefs?.length || duplicate);
}

/**
 * The first choices of a review: new rows without flags on; conflicts,
 * flagged and unimportable rows off. `same` rows are not reviewable.
 */
export function initialChoices(rows: readonly ImportRow[]): ImportChoices {
  const choices: ImportChoices = {};
  for (const row of rows) {
    if (row.state === "same") continue;
    choices[row.name] = {
      selected: row.state === "new" && !hasFlags(row),
      kind: row.proposedKind,
    };
  }
  return choices;
}

/** Whether a choice is ready to save (a disagreeing row needs its dir). */
export function isSaveable(row: ImportRow, choice: ImportChoice | undefined) {
  if (!choice?.selected || row.state === "unimportable") return false;
  return !row.flags.differsAcrossDirs || choice.valueId !== undefined;
}

const KIB = IMPORT_TEXT_MAX_BYTES / 1024;

export function DirStatusStrip({ dirs }: { dirs: readonly ImportReviewDir[] }) {
  const t = useTranslations("variables.import");
  if (dirs.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {dirs.map((dir) => (
        <li
          key={`${dir.serverName}\0${dir.deployDir}`}
          className="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5"
        >
          <span className="min-w-0 truncate font-mono text-xs" dir="ltr">
            {dir.serverName}:{dir.deployDir}
          </span>
          <Badge
            variant={
              dir.status === "ok"
                ? "outline"
                : dir.status === "fileMissing"
                  ? "secondary"
                  : "destructive"
            }
          >
            {t(`dirStatus.${dir.status}`, { kib: KIB, line: dir.line ?? 0 })}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function ImportReviewTable({
  rows,
  choices,
  onChange,
}: {
  rows: readonly ImportRow[];
  choices: ImportChoices;
  onChange: (name: string, patch: Partial<ImportChoice>) => void;
}) {
  const t = useTranslations("variables.import");
  const tVariables = useTranslations("variables");
  const reviewable = rows.filter((row) => row.state !== "same");
  const withSources = reviewable.some((row) => row.flags.differsAcrossDirs);

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <span className="sr-only">{t("colImport")}</span>
            </TableHead>
            <TableHead>{tVariables("colName")}</TableHead>
            <TableHead>{tVariables("colKind")}</TableHead>
            <TableHead>{tVariables("colValue")}</TableHead>
            {withSources && <TableHead>{t("colSource")}</TableHead>}
            <TableHead>{t("colState")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reviewable.map((row) => (
            <ReviewRow
              key={row.name}
              row={row}
              choice={choices[row.name]}
              withSources={withSources}
              onChange={(patch) => onChange(row.name, patch)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ReviewRow({
  row,
  choice,
  withSources,
  onChange,
}: {
  row: ImportRow;
  choice: ImportChoice | undefined;
  withSources: boolean;
  onChange: (patch: Partial<ImportChoice>) => void;
}) {
  const t = useTranslations("variables.import");
  const tVariables = useTranslations("variables");
  const unimportable = row.state === "unimportable";
  const differs = row.flags.differsAcrossDirs === true;
  const chosen = row.sources?.find((s) => s.valueId === choice?.valueId);
  const kind = choice?.kind ?? row.proposedKind;
  // Shown only while the row stays plain: a row turned secret is masked.
  const value = kind === "plain" ? (row.value ?? chosen?.value ?? null) : null;

  return (
    <TableRow data-state={choice?.selected ? "selected" : undefined}>
      <TableCell>
        <Checkbox
          aria-label={t("selectRow", { name: row.name })}
          checked={choice?.selected === true && !unimportable}
          disabled={unimportable || (differs && choice?.valueId === undefined)}
          onCheckedChange={(checked) => onChange({ selected: checked })}
        />
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col gap-1">
          <code className="font-mono text-sm break-all">{row.name}</code>
          <RowFlags row={row} />
        </div>
      </TableCell>
      <TableCell className="align-top">
        <Select
          value={kind}
          onValueChange={(next) => {
            if (next) onChange({ kind: next as VariableKind });
          }}
          disabled={unimportable}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("kindOf", { name: row.name })}
            className="w-28"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VARIABLE_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {tVariables(`kind.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="max-w-xs align-top">
        {value !== null ? (
          <code
            className="block truncate font-mono text-sm"
            title={value}
            dir="ltr"
          >
            {value === "" ? (
              <span className="italic text-muted-foreground">
                {tVariables("emptyValue")}
              </span>
            ) : (
              value
            )}
          </code>
        ) : (
          <span className="font-mono text-sm text-muted-foreground">
            <span aria-hidden>{IMPORT_MASK}</span>
            <span className="sr-only">{t("valueHidden")}</span>
          </span>
        )}
      </TableCell>
      {withSources && (
        <TableCell className="align-top">
          {differs && row.sources && (
            <Select
              value={choice?.valueId ?? null}
              onValueChange={(next) => {
                if (next) onChange({ valueId: next, selected: true });
              }}
              disabled={unimportable}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("dirOf", { name: row.name })}
                className="w-56"
              >
                <SelectValue placeholder={t("chooseDir")} />
              </SelectTrigger>
              <SelectContent>
                {row.sources.map((source) => (
                  <SelectItem key={source.valueId} value={source.valueId}>
                    <span className="truncate font-mono text-xs" dir="ltr">
                      {source.serverName}:{source.deployDir}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </TableCell>
      )}
      <TableCell className="align-top">
        <StateBadge row={row} />
      </TableCell>
    </TableRow>
  );
}

function StateBadge({ row }: { row: ImportRow }) {
  const t = useTranslations("variables.import");
  if (row.state === "unimportable") {
    return (
      <div className="flex flex-col items-start gap-1">
        <Badge variant="destructive">{t("state.unimportable")}</Badge>
        {row.reason && (
          <span className="text-xs text-muted-foreground">
            {t(`reason.${row.reason}`)}
          </span>
        )}
      </div>
    );
  }
  return (
    <Badge variant={row.state === "conflict" ? "secondary" : "outline"}>
      {t(row.state === "conflict" ? "state.conflict" : "state.new")}
    </Badge>
  );
}

function RowFlags({ row }: { row: ImportRow }) {
  const t = useTranslations("variables.import");
  const { differsAcrossDirs, unresolvedRefs, duplicate } = row.flags;
  const lines = [
    differsAcrossDirs && t("flag.differsAcrossDirs"),
    unresolvedRefs?.length &&
      t("flag.unresolvedRefs", { names: unresolvedRefs.join(", ") }),
    duplicate && t("flag.duplicate"),
  ].filter((line): line is string => typeof line === "string");
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <li
          key={line}
          className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

/** The rows that need nothing (`same`) and the names left out, collapsed. */
export function ImportReviewGroups({
  rows,
  skipped,
}: {
  rows: readonly ImportRow[];
  skipped: readonly { name: string; reason: ImportSkipReason }[];
}) {
  const t = useTranslations("variables.import");
  const same = rows.filter((row) => row.state === "same");
  return (
    <>
      {same.length > 0 && (
        <NameGroup
          label={t("sameGroup", { count: same.length })}
          items={same.map((row) => ({ name: row.name }))}
        />
      )}
      {skipped.length > 0 && (
        <NameGroup
          label={t("skippedGroup", { count: skipped.length })}
          items={skipped.map((s) => ({
            name: s.name,
            note: t(`skipReason.${s.reason}`),
          }))}
        />
      )}
    </>
  );
}

function NameGroup({
  label,
  items,
}: {
  label: string;
  items: { name: string; note?: string }[];
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="group/trigger text-muted-foreground"
          />
        }
      >
        <ChevronDown
          data-icon="inline-start"
          className="transition-transform group-data-[panel-open]/trigger:rotate-180"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 ps-8 pt-1 text-sm">
          {items.map((item) => (
            <li key={item.name} className="flex flex-wrap gap-x-2">
              <code className="font-mono">{item.name}</code>
              {item.note && (
                <span className="text-muted-foreground">{item.note}</span>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
