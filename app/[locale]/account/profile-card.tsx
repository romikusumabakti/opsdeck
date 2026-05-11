"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Mail, Pencil, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

type UserSummary = {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean | null;
  image?: string | null;
};

function getInitials(value: string) {
  return value
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function ProfileCard({ user }: { user: UserSummary }) {
  const t = useTranslations("account.profile");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  const schema = z.object({
    name: z.string().min(1, tCommon("required")).max(100),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: user.name },
  });

  useUnsavedChanges(
    editing && form.formState.isDirty && !form.formState.isSubmitting
  );

  async function onSubmit(values: z.infer<typeof schema>) {
    const trimmed = values.name.trim();
    if (trimmed === user.name) {
      setEditing(false);
      return;
    }
    const { error } = await authClient.updateUser({ name: trimmed });
    if (error) {
      toast.error(error.message ?? tCommon("errorGeneric"));
      return;
    }
    toast.success(t("updatedSuccess"));
    setEditing(false);
    router.refresh();
  }

  function onCancel() {
    form.reset({ name: user.name });
    setEditing(false);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription className="mt-1">{t("description")}</CardDescription>
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            className="shrink-0"
          >
            <Pencil className="size-4" />
            {tCommon("edit")}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-4">
          <span className="size-16 rounded-full bg-muted flex items-center justify-center text-xl font-semibold shrink-0">
            {getInitials(user.name || user.email)}
          </span>
          {editing ? (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="flex flex-col gap-3 flex-1 min-w-0"
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("nameLabel")}</FormLabel>
                      <FormControl>
                        <Input autoComplete="name" autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-center gap-2 min-w-0">
                  <Mail className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm text-muted-foreground truncate">
                    {user.email}
                  </span>
                  {user.emailVerified && (
                    <Badge variant="secondary" className="text-xs">
                      {tCommon("verified")}
                    </Badge>
                  )}
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCancel}
                    disabled={form.formState.isSubmitting}
                  >
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={form.formState.isSubmitting}
                  >
                    {form.formState.isSubmitting
                      ? tCommon("loading")
                      : tCommon("save")}
                  </Button>
                </div>
              </form>
            </Form>
          ) : (
            <div className="flex flex-col gap-1.5 min-w-0 flex-1 pt-1">
              <div className="flex items-center gap-2 min-w-0">
                <UserRound className="size-4 text-muted-foreground shrink-0" />
                <span className="font-medium truncate">{user.name}</span>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <Mail className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground truncate">
                  {user.email}
                </span>
                {user.emailVerified && (
                  <Badge variant="secondary" className="text-xs">
                    {tCommon("verified")}
                  </Badge>
                )}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
