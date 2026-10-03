import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Card chrome shared by every Home section: icon + title + optional count and
// action in a header row, the list below.
export function HomeSection({
  icon: Icon,
  iconClassName,
  title,
  count,
  action,
  children,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b text-sm font-medium">
          <Icon
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              iconClassName
            )}
          />
          <span className="flex-1 min-w-0 truncate">{title}</span>
          {count !== undefined ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

// An empty section collapses to one line instead of a tall empty card.
export function CompactSection({
  icon: Icon,
  iconClassName,
  title,
  text,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm">
      <Icon
        className={cn("size-4 shrink-0 text-muted-foreground", iconClassName)}
      />
      <span className="font-medium shrink-0">{title}</span>
      <span className="min-w-0 truncate text-muted-foreground">{text}</span>
    </div>
  );
}
