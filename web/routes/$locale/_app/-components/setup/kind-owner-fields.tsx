import { useTranslations } from "use-intl";
import { type Person, PersonPicker } from "@/components/person-picker";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const ENV_KINDS = ["qa", "dev", "release", "sandbox", "prod"] as const;
export type EnvKind = (typeof ENV_KINDS)[number];
const NONE = "__none";

/** Advanced options: the environment's kind and owner (both optional). */
export function KindOwnerFields({
  kind,
  ownerId,
  owners,
  onKind,
  onOwner,
}: {
  kind: EnvKind | null | undefined;
  ownerId: string | null | undefined;
  owners: Person[] | undefined;
  onKind: (kind: EnvKind | null) => void;
  onOwner: (ownerId: string | null) => void;
}) {
  const t = useTranslations("newEnvironment");
  const tKinds = useTranslations("environmentKinds");
  return (
    <Card>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="env-kind">{t("kind")}</FieldLabel>
          <Select
            value={kind ?? NONE}
            onValueChange={(value) =>
              onKind(value && value !== NONE ? (value as EnvKind) : null)
            }
          >
            <SelectTrigger id="env-kind" aria-label={t("kind")}>
              <SelectValue>
                {(value: string) =>
                  value === NONE ? t("kindNone") : tKinds(value as EnvKind)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("kindNone")}</SelectItem>
              {ENV_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {tKinds(k)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="env-owner">{t("owner")}</FieldLabel>
          <PersonPicker
            id="env-owner"
            aria-label={t("owner")}
            people={owners ?? []}
            value={ownerId ?? null}
            onChange={onOwner}
            noneLabel={t("ownerNone")}
          />
        </Field>
      </CardContent>
    </Card>
  );
}
