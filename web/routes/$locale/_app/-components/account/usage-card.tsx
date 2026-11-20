import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getAllowanceQuery } from "@/web/api/assistant";
import {
  AllowanceBar,
  allowanceMeter,
} from "@/web/components/assistant/allowance-badge";

/** How often the open tab re-reads the allowance (only while it is visible). */
const REFRESH_MS = 60_000;

/**
 * How much of today's assistant limit the caller has used and when it resets
 * (in the reader's zone). Never shows dollars.
 */
export function UsageCard() {
  const t = useTranslations("account.usage");
  const tAssistant = useTranslations("assistant");
  const { data: allowance } = useQuery({
    ...getAllowanceQuery(),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: "always",
  });
  if (!allowance?.enabled) return null;
  const { reached, percent, left } = allowanceMeter(allowance);
  const time = new Date(allowance.resetsAt);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AllowanceBar allowance={allowance} label={t("title")} />
        <p className="text-sm">
          {t("summary", { used: percent, left })}
          <span className="text-muted-foreground">
            {" · "}
            {tAssistant("usageResets", { time })}
          </span>
        </p>
        {reached && (
          <p
            role="status"
            className={cn("text-sm font-medium text-destructive")}
          >
            {t("capReached")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </CardContent>
    </Card>
  );
}
