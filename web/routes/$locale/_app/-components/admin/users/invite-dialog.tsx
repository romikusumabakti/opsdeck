import { zodResolver } from "@hookform/resolvers/zod";
import { UserPlus } from "lucide-react";
import * as React from "react";
import { useTransition } from "react";
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
import { ORG_ROLES } from "@/lib/permissions";
import { inviteUser } from "@/web/api/users";
import type { InvitationAction } from "./types";

const EMPTY = { name: "", email: "", role: "member" as const };

export function InviteDialog({
  open,
  onOpenChange,
  applyOptimistic,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applyOptimistic: (action: InvitationAction) => void;
}) {
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const [, startTransition] = useTransition();

  const schema = z.object({
    name: z.string().min(1, tCommon("required")),
    email: z.string().email(tCommon("emailInvalid")),
    role: z.enum(ORG_ROLES),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY,
  });

  // Reset the form whenever the dialog closes (cancel, Esc, backdrop, or a
  // successful invite) so the next open starts clean.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) form.reset(EMPTY);
    },
    [form, onOpenChange]
  );

  function onInvite(values: z.infer<typeof schema>) {
    startTransition(async () => {
      // Render a placeholder row immediately so the result shows before the
      // server round-trip + revalidatePath completes; React rolls it back when
      // the transition resolves.
      applyOptimistic({
        type: "add",
        invitation: {
          id: `optimistic-${Date.now()}`,
          name: values.name,
          email: values.email,
          role: values.role,
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        },
      });
      const result = await inviteUser(values);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      handleOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("inviteCardTitle")}</DialogTitle>
          <DialogDescription>{t("inviteCardDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onInvite)}>
          <FieldGroup>
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="invite-name">{t("fullName")}</FieldLabel>
                  <Input
                    placeholder={t("fullNamePlaceholder")}
                    {...field}
                    id="invite-name"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="email"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="invite-email">{t("email")}</FieldLabel>
                  <Input
                    type="email"
                    placeholder={t("emailPlaceholder")}
                    {...field}
                    id="invite-email"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="role"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="invite-role">
                    {t("roleLabel")}
                  </FieldLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => field.onChange(v ?? "")}
                  >
                    <SelectTrigger
                      id="invite-role"
                      className="w-full"
                      aria-invalid={fieldState.invalid}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORG_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(`role.${r}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              <UserPlus className="size-4" />
              {form.formState.isSubmitting
                ? t("inviteSubmitting")
                : t("inviteSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
