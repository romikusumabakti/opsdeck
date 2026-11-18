import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  /** Decorative, before the title (the caller marks it aria-hidden). */
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  icon,
  subtitle,
  action,
  className,
}: PageHeaderProps) {
  const heading = (
    <h1
      className="text-2xl font-semibold tracking-tight line-clamp-2 break-words"
      title={title}
    >
      {title}
    </h1>
  );
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="flex flex-col gap-1 min-w-0">
        {icon ? (
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            {heading}
          </div>
        ) : (
          heading
        )}
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
