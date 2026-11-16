import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import type { Allowance } from "@/web/api/assistant";
import { useAssistantErrorText } from "./error-text";

/** Whether the caller has spent the day's cap. */
export const capReached = (allowance: Allowance) => allowance.remainingUsd <= 0;

/**
 * "Left today: $x.xx", or the cap-reached message with the reset time in the
 * reader's zone once the day's allowance is spent.
 */
export function AllowanceBadge({ allowance }: { allowance: Allowance }) {
  const t = useTranslations("assistant");
  const { codeText } = useAssistantErrorText();
  if (capReached(allowance)) {
    return (
      <p className="max-w-sm text-sm text-destructive" role="status">
        {codeText("assistant.daily_cap_reached", {
          capUsd: allowance.capUsd,
          resetsAt: allowance.resetsAt,
        })}
      </p>
    );
  }
  return (
    <Badge variant="outline" title={t("remainingHint")}>
      {t("remaining", { amount: allowance.remainingUsd.toFixed(2) })}
    </Badge>
  );
}
