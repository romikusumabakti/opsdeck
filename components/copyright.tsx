import { cn } from "@/lib/utils";

export function Copyright({ className }: { className?: string }) {
  const year = new Date().getFullYear();
  return (
    <p className={cn("text-xs text-muted-foreground text-center", className)}>
      © {year} the company
    </p>
  );
}
