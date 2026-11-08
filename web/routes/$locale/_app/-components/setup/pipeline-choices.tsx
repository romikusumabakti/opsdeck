import { useTranslations } from "use-intl";
import {
  type SpecDraft,
  SpecEditor,
  useSpecIssues,
} from "@/components/app-registration-fields";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PipelineChoice = {
  mode: "custom" | "generated";
  spec: SpecDraft;
};

export type PipelineRepo = {
  repoFullName: string;
  componentKey: string;
  /** The choice in effect: the admin's, else what detection decided. */
  choice: PipelineChoice;
  /** Index in the input's `advanced.pipelines`, when the admin chose. */
  index: number | null;
};

/**
 * Advanced options for admins (org integration:manage): the pipeline of
 * each repository the create registers, custom or generated with its build
 * spec. Shown only for repositories no app builds yet.
 */
export function PipelineChoices({
  repos,
  issues,
  message,
  onChange,
}: {
  repos: PipelineRepo[];
  /** Issue code by field path (`pipelines.<index>...`). */
  issues: Record<string, string>;
  message: (code: string) => string;
  onChange: (repoFullName: string, choice: PipelineChoice) => void;
}) {
  const t = useTranslations("newEnvironment");
  if (repos.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("pipelines")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {repos.map((repo) => (
          <PipelineChoiceFields
            key={repo.repoFullName}
            repo={repo}
            issues={issues}
            message={message}
            onChange={(choice) => onChange(repo.repoFullName, choice)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function PipelineChoiceFields({
  repo,
  issues,
  message,
  onChange,
}: {
  repo: PipelineRepo;
  issues: Record<string, string>;
  message: (code: string) => string;
  onChange: (choice: PipelineChoice) => void;
}) {
  const t = useTranslations("newEnvironment");
  const { choice } = repo;
  const specIssues = useSpecIssues(choice.spec, "spec");
  const prefix = repo.index === null ? null : `pipelines.${repo.index}`;
  const serverIssue = prefix
    ? Object.entries(issues).find(([field]) => field.startsWith(prefix))?.[1]
    : undefined;
  const id = `pipeline-${repo.componentKey}`;
  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={id}>
          {t("pipelineMode", { repo: repo.repoFullName })}
        </FieldLabel>
        <FieldContent>
          <Select
            value={choice.mode}
            onValueChange={(value) =>
              onChange({
                ...choice,
                mode: value === "custom" ? "custom" : "generated",
              })
            }
          >
            <SelectTrigger
              id={id}
              aria-label={t("pipelineMode", { repo: repo.repoFullName })}
            >
              <SelectValue>
                {(value: string) =>
                  value === "custom"
                    ? t("pipelineModeCustom")
                    : t("pipelineModeGenerated")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="generated">
                {t("pipelineModeGenerated")}
              </SelectItem>
              <SelectItem value="custom">{t("pipelineModeCustom")}</SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription>{t("pipelinesHint")}</FieldDescription>
          {serverIssue && <FieldError>{message(serverIssue)}</FieldError>}
        </FieldContent>
      </Field>
      {choice.mode === "generated" && (
        <SpecEditor
          componentKey={repo.componentKey}
          spec={choice.spec}
          issues={specIssues}
          path="spec"
          onChange={(change) =>
            onChange({ ...choice, spec: change(choice.spec) })
          }
        />
      )}
    </div>
  );
}
