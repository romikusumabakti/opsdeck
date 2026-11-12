import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useEffect } from "react";
import { Controller, useWatch } from "react-hook-form";
import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/user/user-avatar";
import { Link } from "@/i18n/navigation";
import { listAssignableUsersQuery } from "@/web/api/users";
import { Hint, SaveButton } from "./fields";
import {
  ENV_KINDS,
  type SettingsEnvironment,
  type SettingsProject,
  useSettingsFormContext,
} from "./settings-form";

// Sentinels for the "unspecified" options (a Select can't hold "").
const KIND_NONE = "__none";
const OWNER_NONE = "__none";

/**
 * Name, kind, owner and URL. With a domain the URL is derived from it and
 * read-only; without one it is editable under Advanced options, next to the
 * slug and the project.
 */
export function GeneralTab({
  environment,
  domainUrl,
  projects,
  projectKey,
  canDuplicate,
  onSave,
}: {
  environment: SettingsEnvironment;
  // The address of the environment's domain; null without one.
  domainUrl: string | null;
  projects: SettingsProject[];
  projectKey: string;
  canDuplicate: boolean;
  onSave: () => Promise<void>;
}) {
  const t = useTranslations("environmentForm");
  const tSettings = useTranslations("environmentSettings");
  const tKinds = useTranslations("environmentKinds");
  const tPeople = useTranslations("people");
  const form = useSettingsFormContext();
  const hasDomain = domainUrl !== null;
  const { errors } = form.formState;

  // Owner candidates: whoever can be assigned issues in the selected project.
  // The stored owner stays while the project is unchanged, even one
  // deactivated since (not in the list, so added here).
  const projectId = useWatch({ control: form.control, name: "projectId" });
  const ownerId = useWatch({ control: form.control, name: "ownerId" });
  const eligibleOwners = useQuery({
    ...listAssignableUsersQuery(projectId),
    enabled: !!projectId,
  }).data;
  const extraOwner =
    projectId === environment.projectId ? environment.owner : null;
  const ownerOptions = [
    ...(eligibleOwners ?? []).map((u) => ({ ...u, banned: false })),
    ...(extraOwner && !eligibleOwners?.some((u) => u.id === extraOwner.id)
      ? [extraOwner]
      : []),
  ];

  // Picking another project drops an owner who isn't eligible there, once
  // that project's list has loaded.
  useEffect(() => {
    if (!eligibleOwners || !ownerId || ownerId === extraOwner?.id) return;
    if (!eligibleOwners.some((u) => u.id === ownerId)) {
      form.setValue("ownerId", "", { shouldDirty: true });
    }
  }, [eligibleOwners, ownerId, extraOwner?.id, form]);

  // With a domain the server keeps the URL at the domain's address, so the
  // derived address is shown (also for a URL never stored).
  const derivedUrl = (
    <div className="flex flex-col gap-2">
      <Label htmlFor="env-url">{t("url")}</Label>
      <Input
        id="env-url"
        className="font-mono"
        value={domainUrl ?? ""}
        disabled
        readOnly
      />
      <Hint>{tSettings("urlFromDomain")}</Hint>
    </div>
  );
  const urlField = (
    <Controller
      name="url"
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor="env-url">{t("url")}</FieldLabel>
          <Input
            type="url"
            inputMode="url"
            className="font-mono"
            placeholder="https://app.example.com"
            {...field}
            id="env-url"
            aria-invalid={fieldState.invalid}
          />
          <Hint>{t("urlHint")}</Hint>
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent>
          <form onSubmit={form.handleSubmit(onSave)}>
            <FieldGroup>
              <Controller
                name="name"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="env-name">{t("name")}</FieldLabel>
                    <Input
                      placeholder={t("namePlaceholder")}
                      {...field}
                      id="env-name"
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Controller
                  name="kind"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="env-kind">{t("kind")}</FieldLabel>
                      <Select
                        value={field.value || KIND_NONE}
                        onValueChange={(v) =>
                          field.onChange(!v || v === KIND_NONE ? "" : v)
                        }
                      >
                        <SelectTrigger
                          id="env-kind"
                          aria-invalid={fieldState.invalid}
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={KIND_NONE}>
                            {t("kindNone")}
                          </SelectItem>
                          {ENV_KINDS.map((k) => (
                            <SelectItem key={k} value={k}>
                              {tKinds(k)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Hint>{t("kindHint")}</Hint>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
                <Controller
                  name="ownerId"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="env-owner">{t("owner")}</FieldLabel>
                      <Select
                        value={field.value || OWNER_NONE}
                        onValueChange={(v) =>
                          field.onChange(!v || v === OWNER_NONE ? "" : v)
                        }
                      >
                        <SelectTrigger
                          id="env-owner"
                          aria-invalid={fieldState.invalid}
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={OWNER_NONE}>
                            {t("ownerNone")}
                          </SelectItem>
                          {ownerOptions.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              <span className="flex min-w-0 items-center gap-2">
                                <UserAvatar user={u} size="xs" />
                                <span className="truncate">{u.name}</span>
                                {u.banned && (
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    ({tPeople("deactivated")})
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Hint>{t("ownerHint")}</Hint>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>
              {hasDomain && derivedUrl}

              <AdvancedOptions
                attempt={form.formState.submitCount}
                invalid={!!(errors.projectId || (!hasDomain && errors.url))}
              >
                <div className="flex flex-col gap-2">
                  <Label htmlFor="env-slug">{tSettings("slug")}</Label>
                  <Input
                    id="env-slug"
                    className="font-mono"
                    value={environment.slug}
                    disabled
                    readOnly
                  />
                  <Hint>{tSettings("slugHint")}</Hint>
                </div>
                {!hasDomain && urlField}
                <Controller
                  name="projectId"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="env-project">
                        {t("project")}
                      </FieldLabel>
                      <Select
                        value={field.value || null}
                        onValueChange={(v) => field.onChange(v ?? "")}
                      >
                        <SelectTrigger
                          id="env-project"
                          aria-invalid={fieldState.invalid}
                          className="w-full"
                        >
                          <SelectValue placeholder={t("pickProject")} />
                        </SelectTrigger>
                        <SelectContent>
                          {projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                              <span className="ms-2 text-xs text-muted-foreground">
                                {p.key}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </AdvancedOptions>

              <SaveButton />
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {canDuplicate && (
        <Card>
          <CardHeader>
            <CardTitle>{tSettings("duplicateTitle")}</CardTitle>
            <CardDescription>
              {tSettings("duplicateDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              render={
                <Link
                  href={`/${projectKey}/environments/new?from=${environment.id}`}
                />
              }
              nativeButton={false}
              variant="outline"
            >
              <Copy data-icon="inline-start" />
              {tSettings("duplicateButton")}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
