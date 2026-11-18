import { useTranslations } from "use-intl";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ORG_ROLES } from "@/lib/permissions";

// Admins always see every collection, so they are never a choice.
const PICKABLE_ROLES = ORG_ROLES.filter((role) => role !== "admin");

export type CollectionVisibility = {
  restricted: boolean;
  roles: string[];
};

export const EVERYONE: CollectionVisibility = { restricted: false, roles: [] };

/** The state a collection's stored role list starts the dialog in. */
export function visibilityOf(roles: string[] = []): CollectionVisibility {
  return { restricted: roles.length > 0, roles };
}

/** The `visibleToRoles` payload: empty means everyone. */
export function rolesPayload({ restricted, roles }: CollectionVisibility) {
  return restricted ? PICKABLE_ROLES.filter((r) => roles.includes(r)) : [];
}

/** "Only selected roles" with nothing checked is not a valid choice. */
export function isVisibilityValid(value: CollectionVisibility) {
  return !value.restricted || rolesPayload(value).length > 0;
}

export function CollectionVisibilityField({
  value,
  onChange,
  idPrefix,
}: {
  value: CollectionVisibility;
  onChange: (value: CollectionVisibility) => void;
  idPrefix: string;
}) {
  const t = useTranslations("knowledge");
  const tRoles = useTranslations("users");
  const missing = !isVisibilityValid(value);

  return (
    <FieldSet>
      <FieldLegend variant="label">{t("visibleTo")}</FieldLegend>
      <RadioGroup
        value={value.restricted ? "roles" : "everyone"}
        onValueChange={(v) => onChange({ ...value, restricted: v === "roles" })}
      >
        <Field orientation="horizontal">
          <RadioGroupItem value="everyone" id={`${idPrefix}-everyone`} />
          <FieldLabel htmlFor={`${idPrefix}-everyone`}>
            {t("visibleEveryone")}
          </FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem value="roles" id={`${idPrefix}-roles`} />
          <FieldLabel htmlFor={`${idPrefix}-roles`}>
            {t("visibleSelectedRoles")}
          </FieldLabel>
        </Field>
      </RadioGroup>
      {value.restricted && (
        <div
          data-testid="visibility-roles"
          className="flex flex-col gap-2 ps-6"
        >
          {PICKABLE_ROLES.map((role) => (
            <Field key={role} orientation="horizontal">
              <Checkbox
                id={`${idPrefix}-role-${role}`}
                data-role={role}
                checked={value.roles.includes(role)}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    roles: checked
                      ? [...value.roles, role]
                      : value.roles.filter((r) => r !== role),
                  })
                }
              />
              <FieldLabel htmlFor={`${idPrefix}-role-${role}`}>
                {tRoles(`role.${role}`)}
              </FieldLabel>
            </Field>
          ))}
          {missing && <FieldError>{t("pickAtLeastOneRole")}</FieldError>}
        </div>
      )}
      <FieldDescription>{t("adminsSeeEverything")}</FieldDescription>
    </FieldSet>
  );
}
