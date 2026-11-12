import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { listVariablesQuery } from "@/web/api/variables";
import { VariablesClient } from "../variables/variables-client";

/**
 * The environment's variables inside Settings. Only mounted for callers with
 * variable:read, and its panel unmounts when another tab opens, so the list
 * (which can reveal secret values) is requested only while the tab is open.
 */
export function VariablesTab({ environmentId }: { environmentId: string }) {
  const t = useTranslations("common");
  const { data, isPending, isError } = useQuery(
    listVariablesQuery(environmentId)
  );

  if (isPending) return <DataTableSkeleton columns={5} />;
  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("errorGeneric")}</AlertDescription>
      </Alert>
    );
  }
  return <VariablesClient environmentId={environmentId} listing={data} />;
}
