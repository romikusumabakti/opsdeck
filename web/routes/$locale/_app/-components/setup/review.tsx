import { CircleAlert, Loader2, Rocket } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ProvisioningStepSpec } from "@/lib/provisioning/plan";
import type { SetupIssue } from "@/lib/setup/schema";
import { sectionOfField } from "@/lib/setup/sections";
import {
  type ProvisioningLookups,
  StepSentence,
} from "../env/provisioning-step-sentence";
import { useIssueMessage } from "./use-issue-message";

/**
 * The end of the New environment page: what the setup will create, the
 * provisioning steps it will start, and every issue the preview reports. The
 * button stays off while an issue remains or the preview is out of date.
 */
export function SetupReview({
  creates,
  plan,
  lookups,
  issues,
  projectKey,
  checking,
  previewFailed = false,
  onRetry,
  submitting,
  onSubmit,
  children,
}: {
  creates: string[];
  plan: ProvisioningStepSpec[];
  lookups: ProvisioningLookups;
  issues: SetupIssue[];
  projectKey: string;
  /** The input changed and its preview has not come back yet. */
  checking: boolean;
  /** The preview request failed: the answer is unknown, so no create. */
  previewFailed?: boolean;
  onRetry?: () => void;
  submitting: boolean;
  onSubmit: () => void;
  /** Extra content after the plan (the New environment page's summary). */
  children?: React.ReactNode;
}) {
  const t = useTranslations("setupWizard.review");
  const message = useIssueMessage(projectKey);
  const tSections = useTranslations("setupWizard.sections");
  const blocked = issues.length > 0 || checking || previewFailed || submitting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {issues.length > 0 && (
          <section className="flex flex-col gap-2" aria-label={t("issues")}>
            <h3 className="text-sm font-medium text-destructive">
              {t("issues")}
            </h3>
            <ul role="alert" className="flex flex-col gap-1.5">
              {issues.map((issue) => (
                <li
                  key={`${issue.field}:${issue.code}`}
                  className="flex items-start gap-2 text-sm text-destructive"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <strong className="font-medium">
                      {tSections(sectionOfField(issue.field) ?? "general")}
                    </strong>
                    {": "}
                    {message(issue.code)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {previewFailed && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-sm text-destructive"
          >
            <CircleAlert className="size-4 shrink-0" />
            <span>{t("previewFailed")}</span>
            {onRetry && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
              >
                {t("retry")}
              </Button>
            )}
          </div>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("creates")}</h3>
          {creates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("nothingYet")}</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
              {creates.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("plan")}</h3>
          {plan.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("nothingYet")}</p>
          ) : (
            <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm">
              {plan.map((spec, index) => (
                <li key={index}>
                  <StepSentence spec={spec} lookups={lookups} />
                </li>
              ))}
            </ol>
          )}
        </section>

        {children}
      </CardContent>
      <CardFooter className="justify-end gap-3">
        {checking && issues.length === 0 && (
          <span className="text-sm text-muted-foreground">{t("checking")}</span>
        )}
        <Button type="button" disabled={blocked} onClick={onSubmit}>
          {submitting ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Rocket data-icon="inline-start" />
          )}
          {submitting ? t("creating") : t("submit")}
        </Button>
      </CardFooter>
    </Card>
  );
}
