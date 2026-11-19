import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { SearchSelect } from "@/components/search-select";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useGroupErrorMessage } from "@/hooks/use-group-error-message";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { Project as ProjectRow } from "@/lib/db/schema";
import { canManageProjectGroups } from "@/lib/permissions";
import { RESERVED_PROJECT_KEYS } from "@/lib/reserved-paths";
import type { Serialized } from "@/web/api/client";
import { addProject, editProject } from "@/web/api/project-catalog";
import { createGroup, listGroupsQuery } from "@/web/api/project-groups";
import { useMe } from "@/web/api/session";

type Project = Serialized<ProjectRow>;

type Mode = { type: "create" } | { type: "edit"; project: Project };

/** Select value for "no default server". */
const NO_SERVER = "none";
/** SearchSelect value of the "Create group…" entry (never a real id). */
const CREATE_GROUP = "__create-group__";

type Props = {
  mode: Mode;
  /**
   * Optional callbacks to override default navigation. When provided, the form
   * skips its own `router.push` so it can be embedded in a modal.
   */
  onSuccess?: (project: Project) => void;
  onCancel?: () => void;
  /**
   * Edit mode on the settings page: the project's default server. `servers`
   * is every server the caller can list (empty without server:read); only
   * `canChange` (org server:manage) gets a select and sends the field.
   */
  defaultServer?: {
    servers: readonly { id: string; name: string }[];
    canChange: boolean;
  };
};

// Create/edit form for a logical project (the parent of environments). Shared by
// the inline create dialog and the project settings page, so both stay on one
// schema — including the reserved-key check the routing layer depends on.
export function ProjectForm({
  mode,
  onSuccess,
  onCancel,
  defaultServer,
}: Props) {
  const t = useTranslations("projectForm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const initial = mode.type === "edit" ? mode.project : null;

  const schema = z.object({
    name: z.string().trim().min(1, tCommon("required")),
    key: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, t("keyHint"))
      // The key doubles as a top-level URL segment, so mirror the server-side
      // reserved-word check here instead of failing with a generic error.
      .refine(
        (key) => !RESERVED_PROJECT_KEYS.has(key.toUpperCase()),
        t("keyReserved")
      ),
    groupId: z.string().nullable(),
    description: z.string().trim(),
    defaultServerId: z.string(),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      key: initial?.key ?? "",
      groupId: initial?.groupId ?? null,
      description: initial?.description ?? "",
      defaultServerId: initial?.defaultServerId ?? NO_SERVER,
    },
  });
  const tGroups = useTranslations("projectGroups");
  const groupError = useGroupErrorMessage();
  const queryClient = useQueryClient();
  const mayCreateGroup = canManageProjectGroups(useMe()?.orgRole);
  const groups = useQuery(listGroupsQuery()).data ?? [];
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");

  async function createAndSelectGroup() {
    try {
      const group = await createGroup(groupName);
      toast.success(t("groupCreated"));
      await queryClient.invalidateQueries({ queryKey: ["project-groups"] });
      form.setValue("groupId", group.id, { shouldDirty: true });
      setCreatingGroup(false);
      setGroupName("");
    } catch (error) {
      toast.error(groupError(error, tGroups("failed")));
    }
  }

  const canChangeDefaultServer =
    mode.type === "edit" && defaultServer?.canChange === true;

  async function onSubmit(values: Values) {
    const payload = {
      name: values.name,
      key: values.key,
      description: values.description ? values.description : null,
      groupId: values.groupId,
      ...(canChangeDefaultServer && {
        defaultServerId:
          values.defaultServerId === NO_SERVER ? null : values.defaultServerId,
      }),
    };

    const result =
      mode.type === "create"
        ? await addProject(payload)
        : await editProject(mode.project.id, payload);

    if (!result.success || !result.data) {
      toast.error(
        result.message === "keyTaken"
          ? t("keyTaken")
          : mode.type === "create"
            ? t("createFailed")
            : t("saveFailed")
      );
      return;
    }

    toast.success(mode.type === "create" ? t("created") : t("saved"));
    // Reset to the saved values so the unsaved-changes guard doesn't fire on
    // the navigation this success triggers.
    form.reset(values);

    if (onSuccess) {
      onSuccess(result.data);
      return;
    }
    if (mode.type === "create") return;
    // The key is part of the URL, so a renamed project is pushed to its new one.
    router.push(`/${result.data.key}`);
  }

  const loading = form.formState.isSubmitting;

  useUnsavedChanges(form.formState.isDirty && !loading);

  function handleCancel() {
    if (onCancel) {
      onCancel();
      return;
    }
    router.back();
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="project-name">{t("name")}</FieldLabel>
              <Input
                placeholder={t("namePlaceholder")}
                {...field}
                id="project-name"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="key"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="project-key">{t("key")}</FieldLabel>
              <Input
                placeholder={t("keyPlaceholder")}
                autoCapitalize="characters"
                {...field}
                id="project-key"
                aria-invalid={fieldState.invalid}
                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
              />
              <FieldDescription>
                {mode.type === "edit" ? t("keyEditHint") : t("keyHint")}
              </FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="groupId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="project-group">{t("group")}</FieldLabel>
              <SearchSelect
                id="project-group"
                invalid={fieldState.invalid}
                value={field.value}
                onChange={(value) => {
                  if (value === CREATE_GROUP) {
                    setCreatingGroup(true);
                    return;
                  }
                  setCreatingGroup(false);
                  field.onChange(value);
                }}
                options={[
                  ...groups.map((group) => ({
                    value: group.id,
                    label: group.name,
                  })),
                  ...(mayCreateGroup
                    ? [{ value: CREATE_GROUP, label: t("groupCreate") }]
                    : []),
                ]}
                noneLabel={t("groupNone")}
                placeholder={t("groupPlaceholder")}
              />
              {creatingGroup && (
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    aria-label={t("groupCreateName")}
                    placeholder={t("groupCreateName")}
                    value={groupName}
                    maxLength={80}
                    onChange={(e) => setGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter creates the group, not the project.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (groupName.trim()) createAndSelectGroup();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={groupName.trim() === ""}
                    onClick={createAndSelectGroup}
                  >
                    {t("groupCreateAdd")}
                  </Button>
                </div>
              )}
              <FieldDescription>{t("groupDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="project-description">
                {t("description")}
              </FieldLabel>
              <Textarea
                rows={3}
                placeholder={t("descriptionPlaceholder")}
                {...field}
                id="project-description"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        {mode.type === "edit" && defaultServer && (
          <Controller
            name="defaultServerId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="project-default-server-id">
                  {t("defaultServer")}
                </FieldLabel>
                {canChangeDefaultServer ? (
                  <SearchSelect
                    id="project-default-server-id"
                    invalid={fieldState.invalid}
                    value={field.value}
                    onChange={(value) => field.onChange(value ?? NO_SERVER)}
                    options={[
                      { value: NO_SERVER, label: t("defaultServerNone") },
                      ...defaultServer.servers.map((server) => ({
                        value: server.id,
                        label: server.name,
                      })),
                    ]}
                    placeholder={t("defaultServerNone")}
                  />
                ) : (
                  // Without server:read the name is not listable; say who set it.
                  <p className="text-sm">
                    {field.value === NO_SERVER
                      ? t("defaultServerNone")
                      : (defaultServer.servers.find((s) => s.id === field.value)
                          ?.name ?? t("defaultServerSet"))}
                  </p>
                )}
                <FieldDescription>
                  {canChangeDefaultServer
                    ? t("defaultServerDescription")
                    : `${t("defaultServerDescription")} ${t("defaultServerAdminOnly")}`}
                </FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleCancel}
            disabled={loading}
          >
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={loading}>
            {mode.type === "edit"
              ? loading
                ? t("saving")
                : t("saveChanges")
              : loading
                ? t("submitting")
                : t("submit")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
