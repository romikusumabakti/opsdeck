import { cn } from "@/lib/utils";

// An environment's address (IP/hostname) as muted monospace secondary text,
// placed beside its name. Renders nothing when no host is set. Sits above a
// stretched row link (z-10) so its `title` still shows the full host on hover.
export function EnvironmentHost({
  host,
  className,
}: {
  host: string | null | undefined;
  className?: string;
}) {
  if (!host) return null;
  return (
    <span
      title={host}
      className={cn(
        "relative z-10 min-w-0 truncate font-mono text-xs text-muted-foreground",
        className
      )}
    >
      {host}
    </span>
  );
}
