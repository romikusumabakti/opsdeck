import { ExternalLink } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// An environment's web address as a small icon link placed beside its name;
// the tooltip shows the URL. Renders nothing when no URL is set. Opens in a
// new tab. Callers inside a clickable row must render it outside the row's
// own link (no nested interactives); it also stops the click from bubbling to
// a row handler.
export function EnvironmentUrlButton({
  url,
  className,
}: {
  url: string | null | undefined;
  className?: string;
}) {
  const t = useTranslations("common");
  if (!url) return null;
  return (
    <TooltipHint label={url}>
      <Button
        variant="ghost"
        size="icon-xs"
        nativeButton={false}
        className={cn("text-muted-foreground", className)}
        aria-label={t("openUrlInNewTab", { url })}
        onClick={(e) => e.stopPropagation()}
        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      >
        <ExternalLink />
      </Button>
    </TooltipHint>
  );
}
