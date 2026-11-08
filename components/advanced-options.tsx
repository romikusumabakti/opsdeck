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
 * unless `defaultOpen`, or controlled through `open`/`onOpenChange`. It opens
 * when `invalid` turns true, so a failed save shows the field at fault.
 */
export function AdvancedOptions({
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  invalid = false,
}: {
  children: React.ReactNode;
  invalid?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations("setup");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  useEffect(() => {
    if (invalid) setUncontrolledOpen(true);
  }, [invalid]);
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
        {t("advancedOptions")}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
