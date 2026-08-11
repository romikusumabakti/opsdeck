"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { addProject, editProject } from "@/actions/project-catalog";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";
import { RESERVED_PROJECT_KEYS } from "@/lib/reserved-paths";

type Mode = { type: "create" } | { type: "edit"; project: Project };

type Props = {
  mode: Mode;
  /**
   * Optional callbacks to override default navigation. When provided, the form
   * skips its own `router.push` so it can be embedded in a modal.
   */
  onSuccess?: (project: Project) => void;
  onCancel?: () => void;
};

// Create/edit form for a logical project (the parent of environments). Shared by
// the inline create dialog and the project settings page, so both stay on one
// schema — including the reserved-key check the routing layer depends on.
export function ProjectForm({ mode, onSuccess, onCancel }: Props) {
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
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      key: initial?.key ?? "",
      client: initial?.client ?? "",
      description: initial?.description ?? "",
    },
  });

  async function onSubmit(values: Values) {
    const payload = {
      name: values.name,
      key: values.key,
      client: values.client ? values.client : null,
      description: values.description ? values.description : null,
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
    if (mode.type === "create") {
      router.refresh();
      return;
    }
    // The key is part of the URL, so a renamed project is pushed to its new one.
    router.push(`/${result.data.key}`);
    router.refresh();
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
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("name")}</FormLabel>
              <FormControl>
                <Input placeholder={t("namePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("key")}</FormLabel>
              <FormControl>
                <Input
                  placeholder={t("keyPlaceholder")}
                  autoCapitalize="characters"
                  {...field}
                  onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                />
              </FormControl>
              <FormDescription>
                {mode.type === "edit" ? t("keyEditHint") : t("keyHint")}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="client"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("client")}</FormLabel>
              <FormControl>
                <Input placeholder={t("clientPlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("description")}</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder={t("descriptionPlaceholder")}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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
      </form>
    </Form>
  );
}
