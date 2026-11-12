import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/web/api/client";
import { createRelease } from "@/web/api/releases";

export type ReleaseSource = {
  environmentId: string;
  deploymentId: string;
  componentKey: string;
  tag: string;
  // Of the build the tag names: any branch may become a release, so the
  // dialog says plainly which one this is.
  branch: string;
  commitSha: string;
};

/**
 * Marks a successful jar/static deployment as a release: a version name and
 * optional notes. The file is prepared in the background (a run), so success
 * only means it was queued.
 */
export function MarkReleaseDialog({
  source,
  onOpenChange,
}: {
  // Null while closed.
  source: ReleaseSource | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("releases");
  const tDeploys = useTranslations("deploys");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();

  const schema = z.object({
    version: z
      .string()
      .trim()
      .min(1, t("versionRequired"))
      .max(100, t("versionHint")),
    notes: z.string().trim().max(2000, t("notesHint")),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { version: "", notes: "" },
  });

  // A blank form for every deployment it opens on.
  const sourceId = source?.deploymentId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the dialog opens on another deployment
  React.useEffect(() => {
    if (sourceId) form.reset({ version: "", notes: "" });
  }, [sourceId]);

  async function onSubmit(values: Values) {
    if (!source) return;
    try {
      await createRelease(source.environmentId, {
        deploymentId: source.deploymentId,
        version: values.version,
        ...(values.notes && { notes: values.notes }),
      });
      toast.success(tDeploys("releasePreparing"));
      queryClient.invalidateQueries({ queryKey: ["releases"] });
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === "releaseVersionTaken") {
        form.setError("version", { message: t("versionTaken") });
      } else {
        toast.error(
          error instanceof Error ? error.message : tCommon("errorGeneric")
        );
      }
    }
  }

  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("markTitle")}</DialogTitle>
          <DialogDescription>
            {t("markDescription", {
              component: source?.componentKey ?? "",
              tag: source?.tag ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        {source && (
          <div className="rounded-lg border px-3 py-2">
            <p className="text-xs text-muted-foreground">{t("colSource")}</p>
            <p
              className="font-mono text-sm font-medium break-all"
              title={source.commitSha}
            >
              {source.branch} · {source.commitSha.slice(0, 7)}
            </p>
          </div>
        )}
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <FieldGroup>
            <Controller
              name="version"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="release-version">
                    {t("version")}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    {...field}
                    id="release-version"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{t("versionHint")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="notes"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="release-notes">{t("notes")}</FieldLabel>
                  <Textarea
                    {...field}
                    id="release-notes"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{t("notesHint")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
