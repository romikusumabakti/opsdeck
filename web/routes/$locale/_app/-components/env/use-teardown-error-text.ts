import * as React from "react";
import { useTranslations } from "use-intl";
import { TEARDOWN_ERRORS, type TeardownErrorCode } from "@/lib/teardown/errors";

const isTeardownErrorCode = (code: string): code is TeardownErrorCode =>
  Object.hasOwn(TEARDOWN_ERRORS, code);

/**
 * The localized text of a teardown refusal or step failure by its code
 * (`teardown.errors.<code>`). An unknown or missing code gives `fallback`
 * (a localized line of the caller), else the generic step failure: never
 * the API's message.
 */
export function useTeardownErrorText() {
  const t = useTranslations("teardown");
  return React.useCallback(
    (code: string | null | undefined, fallback?: string): string =>
      code && isTeardownErrorCode(code)
        ? t(`errors.${code}`)
        : (fallback ?? t("errors.stepFailed")),
    [t]
  );
}
