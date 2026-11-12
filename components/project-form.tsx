import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { Project as ProjectRow } from "@/lib/db/schema";
import { RESERVED_PROJECT_KEYS } from "@/lib/reserved-paths";
import type { Serialized } from "@/web/api/client";
import { addProject, editProject } from "@/web/api/project-catalog";

type Project = Serialized<ProjectRow>;

type Mode = { type: "create" } | { type: "edit"; project: Project };

/** Select value for "no default server". */
const NO_SERVER = "none";

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
    client: z.string().trim(),
    description: z.string().trim(),
    defaultServerId: z.string(),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      key: initial?.key ?? "",
      client: initial?.client ?? "",
      description: initial?.description ?? "",
      defaultServerId: initial?.defaultServerId ?? NO_SERVER,
    },
  });
  const canChangeDefaultServer =
    mode.type === "edit" && defaultServer?.canChange === true;

  async function onSubmit(values: Values) {
    const payload = {
      name: values.name,
      key: values.key,
      client: values.client ? values.client : null,
      description: values.description ? values.description : null,
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
          name="client"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="project-client">{t("client")}</FieldLabel>
              <Input
                placeholder={t("clientPlaceholder")}
                {...field}
                id="project-client"
                aria-invalid={fieldState.invalid}
              />
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
                  <Select
                    value={field.value}
                    onValueChange={(value) =>
                      field.onChange(value ?? NO_SERVER)
                    }
                  >
                    <SelectTrigger
                      id="project-default-server-id"
                      aria-invalid={fieldState.invalid}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SERVER}>
                        {t("defaultServerNone")}
                      </SelectItem>
                      {defaultServer.servers.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
