import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * The "Advanced options" disclosure of the simple-by-default forms: closed
 * unless `defaultOpen`, or controlled through `open`/`onOpenChange`. When
 * `invalid`, it opens on every save attempt (`attempt` counts them), so a
 * failed save shows the field at fault. `label` replaces "Advanced options"
 * for a disclosure that holds one thing (e.g. "Show install command").
 */
export function AdvancedOptions({
  children,
  label,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  invalid = false,
  attempt = 0,
}: {
  children: React.ReactNode;
  label?: React.ReactNode;
  invalid?: boolean;
  attempt?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations("setup");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each attempt reopens
  useEffect(() => {
    if (invalid) setUncontrolledOpen(true);
  }, [invalid, attempt]);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setUncontrolledOpen(next);
        onOpenChange?.(next);
      }}
      className="flex flex-col gap-4"
    >
      <CollapsibleTrigger className="flex w-fit items-center gap-2 rounded-lg text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground rtl:-scale-x-100" />
        )}
        {label ?? t("advancedOptions")}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
