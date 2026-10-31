import { type LucideIcon, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";

export type RowAction = {
  label: string;
  icon?: LucideIcon;
  /** Runs on click. Omit when `href` or `submenu` is set. */
  onSelect?: () => void;
  /** Navigates instead of running a handler. */
  href?: string;
  /** Nested choices (e.g. roles); the item then opens a submenu. */
  submenu?: RowAction[];
  destructive?: boolean;
  disabled?: boolean;
  /** Why the action is unavailable; shown as muted text beside the label. */
  disabledReason?: string;
};

function ItemContent({ action }: { action: RowAction }) {
  const Icon = action.icon;
  return (
    <>
      {Icon ? <Icon className="size-4" /> : null}
      <span className="flex flex-col">
        {action.label}
        {action.disabled && action.disabledReason ? (
          <span className="text-muted-foreground text-xs">
            {action.disabledReason}
          </span>
        ) : null}
      </span>
    </>
  );
}

function MenuEntry({ action }: { action: RowAction }) {
  if (action.submenu) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={action.disabled}>
          <ItemContent action={action} />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {action.submenu.map((sub) => (
            <MenuEntry key={sub.label} action={sub} />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  return (
    <DropdownMenuItem
      variant={action.destructive ? "destructive" : "default"}
      disabled={action.disabled}
      onClick={action.onSelect}
      render={action.href ? <Link href={action.href} /> : undefined}
    >
      <ItemContent action={action} />
    </DropdownMenuItem>
  );
}

// One primary action as a ghost icon button, everything else behind a ⋯ menu,
// destructive items last after a separator. Rows are not clickable; navigation
// happens only through these controls.
export function RowActions({
  primary,
  items,
  label,
  disabled = false,
}: {
  primary?: RowAction;
  items: RowAction[];
  /** Accessible name of the ⋯ trigger. */
  label: string;
  /** Disables both controls, e.g. while a mutation is pending. */
  disabled?: boolean;
}) {
  const regular = items.filter((i) => !i.destructive);
  const destructive = items.filter((i) => i.destructive);
  const PrimaryIcon = primary?.icon;

  return (
    <div className="flex items-center justify-end gap-1">
      {primary && PrimaryIcon ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={primary.label}
                disabled={disabled || primary.disabled}
                nativeButton={!primary.href}
                onClick={primary.onSelect}
                render={primary.href ? <Link href={primary.href} /> : undefined}
              />
            }
          >
            <PrimaryIcon className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{primary.label}</TooltipContent>
        </Tooltip>
      ) : null}
      {items.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                disabled={disabled}
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {regular.map((a) => (
              <MenuEntry key={a.label} action={a} />
            ))}
            {regular.length > 0 && destructive.length > 0 ? (
              <DropdownMenuSeparator />
            ) : null}
            {destructive.map((a) => (
              <MenuEntry key={a.label} action={a} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
