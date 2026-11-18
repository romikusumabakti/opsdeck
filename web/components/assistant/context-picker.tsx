import { useQuery } from "@tanstack/react-query";
import { AtSign, FolderKanban, Server, Sparkles } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import type { QuestionContextInput } from "@/lib/assistant/context";
import {
  compareEnvironments,
  qualifiedEnvName,
  stripProjectPrefix,
} from "@/lib/nav-path";
import { cn } from "@/lib/utils";
import { listEnvironmentsQuery } from "@/web/api/environments";
import { listProjectsQuery } from "@/web/api/project-catalog";

export type ContextEnvironment = {
  id: string;
  /** Without the project's name in front, as listed under its project. */
  name: string;
  /** With the project's name, for display anywhere else. */
  label: string;
};
export type ContextProject = {
  id: string;
  key: string;
  name: string;
  environments: ContextEnvironment[];
};

const AUTO: QuestionContextInput = { kind: "auto" };

/**
 * The projects (by name) and environments (in kind order under their
 * project) a question can be about: the caller's visible ones, from the
 * lists the app shell already loads. `loaded` once both are in.
 */
export function useContextOptions(): {
  loaded: boolean;
  projects: ContextProject[];
} {
  const projects = useQuery(listProjectsQuery()).data;
  const environments = useQuery(listEnvironmentsQuery()).data;
  return React.useMemo(
    () => ({
      loaded: projects !== undefined && environments !== undefined,
      projects: [...(projects ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({
          id: p.id,
          key: p.key,
          name: p.name,
          environments: (environments ?? [])
            .filter((e) => e.projectId === p.id)
            .sort(compareEnvironments)
            .map((e) => ({
              id: e.id,
              name: stripProjectPrefix(e.name, p.name),
              label: qualifiedEnvName(e.name, p.name),
            })),
        })),
    }),
    [projects, environments]
  );
}

/**
 * `value` if the caller still sees its project or environment, else
 * Automatic. Kept as is until the lists have loaded.
 */
export function visibleContext(
  value: QuestionContextInput,
  options: { loaded: boolean; projects: readonly ContextProject[] }
): QuestionContextInput {
  if (!options.loaded || value.kind === "auto") return value;
  const seen =
    value.kind === "project"
      ? options.projects.some((p) => p.id === value.projectId)
      : options.projects.some((p) =>
          p.environments.some((e) => e.id === value.environmentId)
        );
  return seen ? value : AUTO;
}

/** The picker's item for a context: `auto`, `p:<id>` or `e:<id>`. */
function itemOf(value: QuestionContextInput): string {
  if (value.kind === "project") return `p:${value.projectId}`;
  if (value.kind === "environment") return `e:${value.environmentId}`;
  return "auto";
}

function contextOf(item: string): QuestionContextInput {
  if (item.startsWith("p:"))
    return { kind: "project", projectId: item.slice(2) };
  if (item.startsWith("e:")) {
    return { kind: "environment", environmentId: item.slice(2) };
  }
  return AUTO;
}

type Entry =
  | { kind: "auto"; item: string; search: string }
  | { kind: "project"; item: string; search: string; project: ContextProject }
  | {
      kind: "environment";
      item: string;
      search: string;
      project: ContextProject;
      environment: ContextEnvironment;
    };

type EntryGroup = { value: string; items: Entry[] };

/**
 * What a question is about, as a chip in the composer's footer: Automatic
 * (the assistant picks the projects to read), a project (its branches), or an
 * environment (its running commits). Opens a searchable list: Automatic
 * first, then each project with its environments indented under it; a
 * project's name or key also finds its environments. Typing `@` in the box
 * sets the same state (see `useMentions`).
 */
export function ContextPicker({
  value,
  onChange,
  disabled,
}: {
  value: QuestionContextInput;
  onChange: (value: QuestionContextInput) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("assistant");
  const tCommon = useTranslations("common");
  const { projects } = useContextOptions();

  const groups: EntryGroup[] = React.useMemo(
    () => [
      {
        value: "auto",
        items: [{ kind: "auto", item: "auto", search: t("contextAuto") }],
      },
      {
        value: "projects",
        items: projects.flatMap((project): Entry[] => [
          {
            kind: "project",
            item: `p:${project.id}`,
            search: `${project.name} ${project.key}`,
            project,
          },
          ...project.environments.map(
            (environment): Entry => ({
              kind: "environment",
              item: `e:${environment.id}`,
              search: `${environment.name} ${project.name} ${project.key}`,
              project,
              environment,
            })
          ),
        ]),
      },
    ],
    [projects, t]
  );
  const entries = groups.flatMap((g) => g.items);
  const selected = entries.find((e) => e.item === itemOf(value)) ?? entries[0];
  const label = labelOf(selected, t("contextAuto"));

  return (
    <Combobox
      autoHighlight
      items={groups}
      value={selected ?? null}
      onValueChange={(next: Entry | null) => {
        if (next && next.item !== itemOf(value)) onChange(contextOf(next.item));
      }}
      isItemEqualToValue={(a: Entry, b: Entry) => a.item === b.item}
      itemToStringLabel={(entry: Entry) => entry.search}
      disabled={disabled}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="w-auto max-w-64 min-w-0 shrink justify-between rounded-full font-normal"
            aria-label={t("contextPick", { name: label })}
            disabled={disabled}
          />
        }
      >
        <AtSign className="text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
      </ComboboxTrigger>
      <ComboboxContent className="min-w-72">
        <ComboboxInput showTrigger={false} placeholder={tCommon("search")} />
        <ComboboxEmpty>{tCommon("noResults")}</ComboboxEmpty>
        <ComboboxList>
          {(group: EntryGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.value === "projects" && (
                <ComboboxLabel>{t("contextProjects")}</ComboboxLabel>
              )}
              <ComboboxCollection>
                {(entry: Entry) => (
                  <ComboboxItem
                    key={entry.item}
                    value={entry}
                    aria-label={
                      entry.kind === "environment"
                        ? t("contextEnvironmentLabel", {
                            name: entry.environment.name,
                            project: entry.project.name,
                          })
                        : undefined
                    }
                  >
                    {/* A logical margin on the content, not padding on the item:
                        it indents the start side in RTL too and cannot lose to
                        the item's own padding in tailwind-merge. */}
                    <span
                      className={cn(
                        "flex min-w-0 items-center gap-2",
                        entry.kind === "environment" && "ms-6"
                      )}
                    >
                      <EntryIcon kind={entry.kind} />
                      <span className="truncate">
                        {entry.kind === "auto"
                          ? t("contextAuto")
                          : entry.kind === "project"
                            ? entry.project.name
                            : entry.environment.name}
                      </span>
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function labelOf(entry: Entry | undefined, autoLabel: string): string {
  if (entry?.kind === "project") return entry.project.name;
  if (entry?.kind === "environment") return entry.environment.label;
  return autoLabel;
}

function EntryIcon({ kind }: { kind: Entry["kind"] }) {
  const Icon =
    kind === "auto" ? Sparkles : kind === "project" ? FolderKanban : Server;
  return <Icon className="text-muted-foreground" aria-hidden />;
}
