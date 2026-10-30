import { useTranslations } from "use-intl";
import type { EnvironmentListItem } from "@/web/api/environments";

// The small uppercase pill marking an environment's purpose (DEV, QA, …) in
// pickers. Renders nothing for environments without a kind.
export function EnvironmentKindBadge({
  kind,
}: {
  kind: EnvironmentListItem["kind"];
}) {
  const t = useTranslations("environmentKinds");
  if (!kind) return null;
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      {t(kind)}
    </span>
  );
}
