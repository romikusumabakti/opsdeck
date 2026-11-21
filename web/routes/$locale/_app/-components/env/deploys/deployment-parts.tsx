import { ScrollText, Zap } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { runActorLabel } from "@/lib/deploy/run-actor";
import type { TimelineDeployment } from "./timeline-model";

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;

/** A run's length as text: "45s", "2m 5s", "1h 3m"; null when unknown. */
export function useDurationText(): (ms: number | null) => string | null {
  const format = useFormatter();
  return (ms) => {
    if (ms === null) return null;
    const unit = (n: number, u: "second" | "minute" | "hour") =>
      format.number(n, { style: "unit", unit: u, unitDisplay: "narrow" });
    const total = Math.round(ms / SECOND_MS);
    if (total < MINUTE_S) return unit(total, "second");
    if (total < HOUR_S) {
      return `${unit(Math.floor(total / MINUTE_S), "minute")} ${unit(
        total % MINUTE_S,
        "second"
      )}`;
    }
    return `${unit(Math.floor(total / HOUR_S), "hour")} ${unit(
      Math.floor((total % HOUR_S) / MINUTE_S),
      "minute"
    )}`;
  };
}

/** A run's length: "45s", "2m 5s", "1h 3m"; nothing when unknown. */
export function DurationText({ ms }: { ms: number | null }) {
  return useDurationText()(ms);
}

type ActorKind = ReturnType<typeof runActorLabel>["kind"];

// Who started a deployment: the kind (for the icon) and the text.
function useDeploymentActor(): (d: TimelineDeployment) => {
  kind: ActorKind;
  text: string;
} {
  const t = useTranslations("deploys");
  return (d) => {
    const actor = runActorLabel({
      userName: d.userName,
      autoUserName: d.autoUser?.name,
      triggeredBy: d.triggeredBy,
      auto: d.trigger === "auto",
    });
    switch (actor.kind) {
      case "user":
        return { kind: actor.kind, text: actor.name };
      case "autoUser":
        return {
          kind: actor.kind,
          text: t("byAutoUser", { user: actor.name }),
        };
      case "auto":
        return {
          kind: actor.kind,
          text:
            actor.by === null
              ? t("byAuto")
              : t("byAutoUser", { user: actor.by }),
        };
      default:
        return { kind: actor.kind, text: t("userUnknown") };
    }
  };
}

/** Who started a deployment, as plain text for translated sentences. */
export function useDeploymentActorText(): (d: TimelineDeployment) => string {
  const actor = useDeploymentActor();
  return (d) => actor(d).text;
}

/** Who started a deployment; an auto deploy gets a bolt, an unknown user italics. */
export function DeploymentActor({
  deployment,
}: {
  deployment: TimelineDeployment;
}) {
  const { kind, text } = useDeploymentActor()(deployment);
  switch (kind) {
    case "user":
      return <span>{text}</span>;
    case "autoUser":
    case "auto":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Zap className="size-3.5 shrink-0" aria-hidden />
          {text}
        </span>
      );
    default:
      return <span className="italic">{text}</span>;
  }
}

/** Opens a deployment's run log. */
export function ViewLogButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("deploys");
  return (
    <Button variant="ghost" size="xs" onClick={onClick}>
      <ScrollText data-icon="inline-start" />
      {t("viewLog")}
    </Button>
  );
}
