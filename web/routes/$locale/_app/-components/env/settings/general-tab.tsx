import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useEffect } from "react";
import { useWatch } from "react-hook-form";
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
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
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
import {
  ENV_KINDS,
  Hint,
  SaveButton,
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
  hasDomain,
  projects,
  projectKey,
  canDuplicate,
  onSave,
}: {
  environment: SettingsEnvironment;
  hasDomain: boolean;
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

  const urlField = (
    <FormField
      control={form.control}
      name="url"
      render={({ field }) => (
        <FormItem>
          <FormLabel htmlFor="env-url">{t("url")}</FormLabel>
          <FormControl id="env-url">
            <Input
              type="url"
              inputMode="url"
              className="font-mono"
              placeholder="https://app.example.com"
              disabled={hasDomain}
              {...field}
            />
          </FormControl>
          <Hint>{hasDomain ? tSettings("urlFromDomain") : t("urlHint")}</Hint>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent>
          <form
            onSubmit={form.handleSubmit(onSave)}
            className="flex flex-col gap-6"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="env-name">{t("name")}</FormLabel>
                  <FormControl id="env-name">
                    <Input placeholder={t("namePlaceholder")} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("kind")}</FormLabel>
                    <Select
                      value={field.value || KIND_NONE}
                      onValueChange={(v) =>
                        field.onChange(!v || v === KIND_NONE ? "" : v)
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
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
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="ownerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("owner")}</FormLabel>
                    <Select
                      value={field.value || OWNER_NONE}
                      onValueChange={(v) =>
                        field.onChange(!v || v === OWNER_NONE ? "" : v)
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
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
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {hasDomain && urlField}

            <AdvancedOptions
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
              <FormField
                control={form.control}
                name="projectId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("project")}</FormLabel>
                    <Select
                      value={field.value || null}
                      onValueChange={(v) => field.onChange(v ?? "")}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("pickProject")} />
                        </SelectTrigger>
                      </FormControl>
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
                    <FormMessage />
                  </FormItem>
                )}
              />
            </AdvancedOptions>

            <SaveButton />
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
