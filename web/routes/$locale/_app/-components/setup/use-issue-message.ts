import { useTranslations } from "use-intl";
import {
  isSetupIssueCode,
  issueMessagePath,
  issueParams,
} from "@/lib/setup/issues";
import { ApiError } from "@/web/api/client";

/** The text of an issue code, with the project's name prefixes filled in. */
export function useIssueMessage(projectKey: string): (code: string) => string {
  const t = useTranslations();
  const params = issueParams(projectKey);
  return (code) => t(issueMessagePath(code), params);
}

/**
 * The text of a failed setup call: a refusal whose code the setup messages
 * know, localised by that code; else the server's message. Null for anything
 * but an ApiError, and for a 401 (the page is going to sign-in).
 */
export function useApiErrorMessage(
  projectKey: string
): (error: unknown) => string | null {
  const message = useIssueMessage(projectKey);
  return (error) => {
    if (!(error instanceof ApiError) || error.status === 401) return null;
    return error.code && isSetupIssueCode(error.code)
      ? message(error.code)
      : error.message;
  };
}
