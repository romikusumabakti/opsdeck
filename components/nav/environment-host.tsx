import { cn } from "@/lib/utils";

// An environment's address (IP/hostname) as muted monospace secondary text,
// placed beside its name. Renders nothing when no host is set.
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
        "min-w-0 truncate font-mono text-xs text-muted-foreground",
        className
      )}
    >
      {host}
    </span>
  );
}
