import { ExternalLink } from "lucide-react";
import { useTranslations } from "use-intl";
import { buttonVariants } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const HTTP_URL = /^https?:\/\//i;

// An environment's web address as a small icon link placed beside its name;
// the tooltip shows the URL. Renders nothing when no URL is set. Opens in a
// new tab. Callers inside a clickable row must render it outside the row's
// own link (no nested interactives); it also stops the click from bubbling to
// a row handler. A plain <a> styled as a ghost icon button, not a Button
// rendering an <a>: that would give it role="button" and hide that it is a
// link.
export function EnvironmentUrlButton({
  url,
  className,
}: {
  url: string | null | undefined;
  className?: string;
}) {
  const t = useTranslations("common");
  // Defense in depth: the server only stores http(s) URLs, but never render
  // any other scheme (e.g. `javascript:`) as a link.
  if (!url || !HTTP_URL.test(url)) return null;
  return (
    <TooltipHint label={url}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("openUrlInNewTab", { url })}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "text-muted-foreground",
          className
        )}
      >
        <ExternalLink />
      </a>
    </TooltipHint>
  );
}
