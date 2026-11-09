import { Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { useDialog } from "@/components/dialog-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/i18n/navigation";
import type { Environment } from "@/lib/db/schema";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import {
  deleteEnvironment,
  type StartTeardownBody,
  startTeardown,
} from "@/web/api/environments";
import { useMe } from "@/web/api/session";
import { useTeardownErrorText } from "./teardown-banner";

const REMOVES = [
  "deleteRemovesContainers",
  "deleteRemovesDatabase",
  "deleteRemovesFolder",
  "deleteRemovesAddress",
] as const;

/**
 * Settings → Danger zone: deletes the environment for good (a teardown:
 * archive, bring down, remove; its progress shows in the TeardownBanner),
 * behind the typed name. Production: only admins, who also tick a
 * confirmation. Admins also get "Remove from Panel only" (rows only) under
 * Advanced options.
 */
export function DeleteEnvironmentCard({
  environment,
  projectKey,
}: {
  environment: Pick<Environment, "id" | "name" | "kind">;
  projectKey: string;
}) {
  const t = useTranslations("environmentSettings");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
  const errorText = useTeardownErrorText();
  const orgRole = useMe()?.orgRole;
  const isAdmin = canOrg(orgRole, { server: ["manage"] });
  // Only admins with integration:manage may delete escrowed variables too.
  const canDeleteEscrowed = canOrg(orgRole, { integration: ["manage"] });
  const production = environment.kind === "prod";
  // The API refuses engineers on production (environmentIsProduction).
  const blocked = production && !isAdmin;

  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [productionConfirmed, setProductionConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const nameMatches = typed === environment.name;
  const canConfirm =
    nameMatches && (!production || productionConfirmed) && !pending;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setTyped("");
      setProductionConfirmed(false);
      setError(null);
    }
  }

  // Asked after a refusal for escrowed variables, with this dialog closed.
  async function confirmEscrowed(): Promise<boolean> {
    onOpenChange(false);
    return dialog.confirm({
      title: t("deleteEscrowedTitle"),
      description: t("deleteEscrowedDescription"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
  }

  async function onDelete() {
    const body: StartTeardownBody = {
      confirmName: typed,
      ...(production ? { confirmProduction: true } : {}),
    };
    setPending(true);
    setError(null);
    // Once the escrow question closed this dialog, failures go to a toast.
    let closed = false;
    try {
      try {
        await startTeardown(environment.id, body);
      } catch (refusal) {
        const escrowed =
          refusal instanceof ApiError &&
          refusal.code === "environmentHasEscrowedVariables";
        if (!escrowed || !canDeleteEscrowed) throw refusal;
        closed = true;
        if (!(await confirmEscrowed())) return;
        await startTeardown(environment.id, {
          ...body,
          confirmEscrowedDeletion: true,
        });
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status !== 401) {
        const message = errorText(failure.code, failure.message);
        if (closed) toast.error(message);
        else setError(message);
        return;
      }
      throw failure;
    } finally {
      setPending(false);
    }
    onOpenChange(false);
    toast.success(t("deleteStarted", { name: environment.name }));
  }

  async function onRemoveFromPanel() {
    setPending(true);
    setError(null);
    let closed = false;
    try {
      let result = await deleteEnvironment(environment.id);
      if (!result.success && result.escrowed && canDeleteEscrowed) {
        closed = true;
        if (!(await confirmEscrowed())) return;
        result = await deleteEnvironment(environment.id, true);
      }
      if (!result.success) {
        const message = result.escrowed
          ? errorText("environmentHasEscrowedVariables")
          : (result.message ?? t("deleteFailed"));
        if (closed) toast.error(message);
        else setError(message);
        return;
      }
    } finally {
      setPending(false);
    }
    onOpenChange(false);
    toast.success(t("removedFromPanel", { name: environment.name }));
    router.push(`/${projectKey}`);
  }

  return (
    <>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 data-icon="inline-start" />
        {t("deleteButton")}
      </Button>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { name: environment.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc ps-5 text-sm">
            {REMOVES.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            {t("deleteBackupKept")}
          </p>

          {blocked ? (
            <Alert>
              <TriangleAlert />
              <AlertDescription>
                {t("deleteProductionEngineer")}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="delete-environment-confirm">
                  {t("deleteConfirmLabel", { name: environment.name })}
                </FieldLabel>
                <Input
                  id="delete-environment-confirm"
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-invalid={typed.length > 0 && !nameMatches}
                />
              </Field>
              {production && (
                <Field orientation="horizontal">
                  <Checkbox
                    id="delete-environment-production"
                    checked={productionConfirmed}
                    onCheckedChange={(checked) =>
                      setProductionConfirmed(checked === true)
                    }
                  />
                  <FieldLabel
                    htmlFor="delete-environment-production"
                    className="font-normal"
                  >
                    {t("deleteProductionConfirm")}
                  </FieldLabel>
                </Field>
              )}
              {isAdmin && (
                <AdvancedOptions>
                  <p className="text-sm text-muted-foreground">
                    {t("removeFromPanelDescription")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-fit"
                    disabled={!nameMatches || pending}
                    onClick={() => void onRemoveFromPanel()}
                  >
                    {t("removeFromPanel")}
                  </Button>
                </AdvancedOptions>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>
              {blocked ? tCommon("close") : tCommon("cancel")}
            </AlertDialogCancel>
            {!blocked && (
              <Button
                type="button"
                variant="destructive"
                disabled={!canConfirm}
                onClick={() => void onDelete()}
              >
                {t("deleteConfirm")}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
