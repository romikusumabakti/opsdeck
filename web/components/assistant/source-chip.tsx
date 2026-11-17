import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { SearchSelect } from "@/components/search-select";
import { compareEnvironments, stripProjectPrefix } from "@/lib/nav-path";
import { getProjectWithEnvironmentsQuery } from "@/web/api/project-catalog";

/**
 * The project's environments the caller can see, in display order, as source
 * options. Empty until the project has loaded.
 */
export function useSourceEnvironments(projectId: string) {
  const project = useQuery(getProjectWithEnvironmentsQuery(projectId)).data;
  return {
    loaded: project !== undefined,
    environments: [...(project?.environments ?? [])]
      .sort(compareEnvironments)
      .map((e) => ({
        id: e.id,
        name: stripProjectPrefix(e.name, project?.name ?? ""),
      })),
  };
}

/**
 * What a question asks about: the project branches (null, the default) or
 * the commits running in one of the project's environments.
 */
export function SourceChip({
  projectId,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  value: string | null;
  onChange: (environmentId: string | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("assistant");
  const { environments } = useSourceEnvironments(projectId);
  const selected =
    environments.find((e) => e.id === value)?.name ??
    t("sourceProjectBranches");
  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      options={environments.map((e) => ({ value: e.id, label: e.name }))}
      noneLabel={t("sourceProjectBranches")}
      placeholder={t("sourceProjectBranches")}
      aria-label={`${t("sourceLabel")}: ${selected}`}
      disabled={disabled}
      className="w-auto max-w-56"
    />
  );
}
