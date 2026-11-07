import { useTranslations } from "use-intl";
import { issueMessagePath, issueParams } from "@/lib/setup/issues";

/** The text of an issue code, with the project's name prefixes filled in. */
export function useIssueMessage(projectKey: string): (code: string) => string {
  const t = useTranslations();
  const params = issueParams(projectKey);
  return (code) => t(issueMessagePath(code), params);
}
