import { cn } from "@/lib/utils";

/** The host (with any port) of an environment's URL, or null when it has no
 * URL or the URL does not parse. */
export function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

// An environment's address (the host of its URL) as muted monospace secondary
// text, placed beside its name. Renders nothing when there is no parseable URL.
// Sits above a stretched row link (z-10) so its `title` still shows the full
// host on hover.
export function EnvironmentHost({
  url,
  className,
}: {
  url: string | null | undefined;
  className?: string;
}) {
  const host = urlHost(url);
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
