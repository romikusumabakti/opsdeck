import { ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; href?: string };

/**
 * Trail rendered at the top of a knowledge page's content column —
 * `Knowledge / <collection> / <title>`. Server component: the reader already
 * holds the collection and title, so no client data round-trip. The last crumb
 * is the current page (not a link); earlier ones link where a destination
 * exists.
 */
export async function KnowledgeBreadcrumb({ items }: { items: Crumb[] }) {
  const t = await getTranslations("knowledge");
  const trail: Crumb[] = [{ label: t("title"), href: "/knowledge" }, ...items];

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
    >
      {trail.map((c, i) => {
        const isLast = i === trail.length - 1;
        return (
          <span
            key={`${c.label}-${i}`}
            className="flex min-w-0 items-center gap-1"
          >
            {i > 0 && (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
            )}
            {c.href && !isLast ? (
              <Link
                href={c.href}
                className="truncate rounded px-1 hover:text-foreground hover:underline"
              >
                {c.label}
              </Link>
            ) : (
              <span
                className={cn("truncate", isLast && "text-foreground")}
                aria-current={isLast ? "page" : undefined}
              >
                {c.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
