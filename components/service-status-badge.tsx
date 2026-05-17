"use client";

import { CircleAlert, CircleHelp, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { ServiceState } from "@/lib/services";

export function ServiceStatusBadge({
  state,
  loading,
}: {
  state: ServiceState;
  loading?: boolean;
}) {
  const t = useTranslations("services.states");
  if (loading) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3 animate-spin" />
        {t("checking")}
      </Badge>
    );
  }
  if (state === "running") {
    return (
      <Badge className="bg-success/15 text-success hover:bg-success/15 border-transparent gap-1">
        <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
        {t("running")}
      </Badge>
    );
  }
  if (state === "stopped") {
    return (
      <Badge variant="secondary" className="gap-1">
        <span
          className="size-1.5 rounded-full bg-muted-foreground"
          aria-hidden="true"
        />
        {t("stopped")}
      </Badge>
    );
  }
  if (state === "not-found") {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleAlert className="size-3" />
        {t("notFound")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <CircleHelp className="size-3" />
      {t("unknown")}
    </Badge>
  );
}
