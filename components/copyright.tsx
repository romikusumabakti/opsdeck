import { cn } from "@/lib/utils";
import { useBootstrap } from "@/web/api/session";

export function Copyright({ className }: { className?: string }) {
  const { companyName } = useBootstrap();
  const year = new Date().getFullYear();
  return (
    <p className={cn("text-xs text-muted-foreground text-center", className)}>
      © {year} {companyName}
    </p>
  );
}
