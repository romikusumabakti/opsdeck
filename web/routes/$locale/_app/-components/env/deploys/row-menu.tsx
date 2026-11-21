import {
  ExternalLink,
  PackageCheck,
  Rocket,
  RotateCcw,
  ScrollText,
  Undo2,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { type RowAction, RowActions } from "@/components/ui/row-actions";
import type { CardActions } from "./target-header";
import {
  logDeployment,
  type RowActionPlan,
  releaseDeployment,
  type TimelineRow,
} from "./timeline-model";

/**
 * The row's ⋯ menu. Every deploy and rollback goes through the card's
 * confirming `actions`; the plan (from `rowActions`) decides what is offered.
 */
export function TimelineRowMenu({
  row,
  plans,
  actions,
  lockedReason,
  queuedHint,
  sourceBranch,
}: {
  row: TimelineRow;
  plans: RowActionPlan[];
  actions: CardActions;
  // Set while the environment is locked: manual deploys and rollbacks are off.
  lockedReason: string | null;
  // Set while another deploy in the environment runs first.
  queuedHint: string | null;
  sourceBranch: string;
}) {
  const t = useTranslations("deploys");

  // Deploys and rollbacks: off while locked or while a request is in flight.
  function gated(item: RowAction, plan: RowActionPlan): RowAction {
    if (plan.disabledReason === "notBuilt") {
      return {
        ...item,
        disabled: true,
        disabledReason: t("notBuilt", { branch: sourceBranch }),
      };
    }
    if (lockedReason !== null) {
      return { ...item, disabled: true, disabledReason: lockedReason };
    }
    return actions.pending === null ? item : { ...item, disabled: true };
  }

  const items = plans.flatMap((plan): RowAction[] => {
    switch (plan.kind) {
      case "deploy":
        return [
          gated(
            {
              label: t("deployThis"),
              icon: Rocket,
              description: queuedHint ?? undefined,
              onSelect: () => actions.deploy(row.tag),
            },
            plan
          ),
        ];
      case "redeploy":
        return [
          gated(
            {
              label: t("redeploy"),
              icon: RotateCcw,
              description: queuedHint ?? undefined,
              onSelect: () => actions.deploy(row.tag),
            },
            plan
          ),
        ];
      case "rollback":
        return [
          gated(
            {
              label: t("rollbackThis"),
              icon: Undo2,
              destructive: true,
              onSelect: () => actions.rollback(),
            },
            plan
          ),
        ];
      case "markRelease": {
        const source = releaseDeployment(row);
        return source
          ? [
              {
                label: t("markRelease"),
                icon: PackageCheck,
                onSelect: () => actions.markRelease(source),
              },
            ]
          : [];
      }
      case "viewPipeline": {
        const url = row.build?.pipelineUrl;
        return url
          ? [
              {
                label: t("viewPipeline"),
                icon: ExternalLink,
                href: url,
                external: true,
                ariaLabel: `${t("viewPipeline")} ${t("opensInNewTab")}`,
              },
            ]
          : [];
      }
      case "viewLog": {
        const runId = logDeployment(row)?.runId;
        return runId
          ? [
              {
                label: t("viewLog"),
                icon: ScrollText,
                onSelect: () => actions.viewLog({ runId, tag: row.tag }),
              },
            ]
          : [];
      }
      default:
        return [];
    }
  });

  return (
    <RowActions label={t("rowActionsLabel", { tag: row.tag })} items={items} />
  );
}
