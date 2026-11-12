import { useMemo } from "react";
import { useTranslations } from "use-intl";
import { COMPACT_TRIGGER } from "@/components/compact-trigger";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { UserAvatar } from "@/components/user/user-avatar";
import { cn } from "@/lib/utils";

export type Person = {
  id: string;
  name: string;
  image: string | null;
  email?: string | null;
  status?: { emoji: string | null; text: string | null } | null;
  banned?: boolean;
};

// UserAvatar's optional email is `string | undefined`, not nullable.
const avatarUser = ({ id, name, image }: Person) => ({ id, name, image });

/**
 * Searchable single-person picker (name or email). `null` means "nobody"; it
 * is only offered, as the first item, when `noneLabel` is set.
 */
export function PersonPicker({
  people,
  value,
  onChange,
  noneLabel,
  placeholder,
  variant = "default",
  id,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  disabled,
  className,
}: {
  people: readonly Person[];
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel?: string;
  placeholder?: string;
  variant?: "default" | "compact";
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("personPicker");
  const tp = useTranslations("people");
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const items = useMemo<(string | null)[]>(
    () => [
      ...(noneLabel === undefined ? [] : [null]),
      ...people.map((p) => p.id),
    ],
    [people, noneLabel]
  );
  const compact = variant === "compact";

  function triggerContent() {
    if (value === null) {
      return noneLabel !== undefined ? (
        <span className="truncate">{noneLabel}</span>
      ) : (
        <span className="truncate text-muted-foreground">{placeholder}</span>
      );
    }
    const person = byId.get(value);
    // A value outside the list (e.g. a user since removed from the project).
    if (!person) return <span className="truncate">—</span>;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <UserAvatar user={avatarUser(person)} size="xs" />
        <span className="truncate">{person.name}</span>
        {person.status?.emoji ? <span>{person.status.emoji}</span> : null}
      </span>
    );
  }

  return (
    <Combobox
      autoHighlight
      items={items}
      value={value}
      onValueChange={(next) => onChange(next)}
      itemToStringLabel={(item: string | null) => {
        if (item === null) return noneLabel ?? "";
        const p = byId.get(item);
        return p ? `${p.name} ${p.email ?? ""}` : "";
      }}
    >
      <ComboboxTrigger
        render={
          <Button
            variant={compact ? "ghost" : "outline"}
            className={
              compact
                ? cn(COMPACT_TRIGGER, className)
                : cn("h-8 w-full justify-between font-normal", className)
            }
            id={id}
            aria-label={ariaLabel}
            aria-invalid={ariaInvalid}
            disabled={disabled}
          />
        }
      >
        {triggerContent()}
      </ComboboxTrigger>
      <ComboboxContent className={compact ? "w-72" : undefined}>
        <ComboboxInput showTrigger={false} placeholder={t("search")} />
        <ComboboxEmpty>{t("empty")}</ComboboxEmpty>
        <ComboboxList>
          {(item: string | null) => {
            if (item === null) {
              return (
                <ComboboxItem key="none" value={null}>
                  {noneLabel}
                </ComboboxItem>
              );
            }
            const p = byId.get(item);
            if (!p) return null;
            return (
              <ComboboxItem key={p.id} value={p.id}>
                <UserAvatar user={avatarUser(p)} size="xs" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {p.name}
                    {p.status?.emoji ? ` ${p.status.emoji}` : ""}
                    {p.banned ? ` (${tp("deactivated")})` : ""}
                  </span>
                  {p.email ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {p.email}
                    </span>
                  ) : null}
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
