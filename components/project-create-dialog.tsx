"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { addProject } from "@/actions/project-catalog";
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { Project } from "@/lib/db/schema";
import { RESERVED_PROJECT_KEYS } from "@/lib/reserved-paths";

// Inline "create a logical project" dialog, opened from the environment form's
// project picker so an admin never has to leave the flow to add the parent.
export function ProjectCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
}) {
  const t = useTranslations("projectCreateDialog");
  const tCommon = useTranslations("common");

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
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", key: "", client: "" },
  });

  async function onSubmit(values: Values) {
    const result = await addProject({
      name: values.name,
      key: values.key,
      client: values.client ? values.client : null,
    });
    if (!result.success || !result.data) {
      toast.error(
        result.message === "keyTaken" ? t("keyTaken") : t("createFailed")
      );
      return;
    }
    toast.success(t("created"));
    onCreated(result.data);
    form.reset();
    onOpenChange(false);
  }

  const loading = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
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
                      onChange={(e) =>
                        field.onChange(e.target.value.toUpperCase())
                      }
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("keyHint")}
                  </p>
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
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={loading}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? t("submitting") : t("submit")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
