import {
  Eye,
  EyeOff,
  KeyRound,
  ListPlus,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { useDialog } from "@/components/dialog-provider";
import { useProjectCan } from "@/components/project-role";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RowActions } from "@/components/ui/row-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canOrg } from "@/lib/permissions";
import { useMe } from "@/web/api/session";
import {
  applyVariableTemplate,
  deleteVariable,
  regenerateVariable,
  revealVariables,
  type VariableRow,
  type VariablesListing,
} from "@/web/api/variables";
import {
  useVariableErrorText,
  VariableFormDialog,
} from "./variable-form-dialog";

const MASK = "••••••••";

type FormState = { variable: VariableRow | null } | null;

export function VariablesClient({
  environmentId,
  listing,
}: {
  environmentId: string;
  listing: VariablesListing;
}) {
  const t = useTranslations("variables");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const errorText = useVariableErrorText();
  const canWrite = useProjectCan({ variable: ["write"] });
  const canClearEscrow = canOrg(useMe()?.orgRole, {
    integration: ["manage"],
  });
  const [form, setForm] = React.useState<FormState>(null);
  // Decrypted values by name, only after an explicit reveal, only in memory.
  const [revealed, setRevealed] = React.useState<Map<string, string> | null>(
    null
  );
  const [busy, setBusy] = React.useState<string | null>(null);

  // Any change to the listing (a save, a regenerate, a refetch) drops the
  // revealed values: they may be stale, and a reveal is a deliberate act.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listing is the trigger
  React.useEffect(() => {
    setRevealed(null);
  }, [listing]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  function onReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    void run("reveal", async () => {
      const result = await revealVariables(environmentId);
      setRevealed(
        new Map(result.variables.map((v) => [v.name, v.value ?? ""] as const))
      );
    });
  }

  function onApplyTemplate() {
    void run("template", async () => {
      const { added, missing } = await applyVariableTemplate(environmentId);
      toast.success(t("templateApplied", { count: added.length }));
      if (missing.length > 0) {
        toast.warning(t("templateMissing", { names: missing.join(", ") }));
      }
    });
  }

  async function onRegenerate(variable: VariableRow) {
    const ok = await dialog.confirm({
      title: t("regenerateConfirmTitle", { name: variable.name }),
      description: t("regenerateConfirmDescription"),
      confirmText: t("regenerate"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    await run(variable.name, async () => {
      await regenerateVariable(environmentId, variable.name);
      toast.success(t("regenerated", { name: variable.name }));
    });
  }

  async function onDelete(variable: VariableRow) {
    const ok = await dialog.confirm({
      title: t("deleteConfirmTitle", { name: variable.name }),
      description: t("deleteConfirmDescription"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    await run(variable.name, async () => {
      await deleteVariable(environmentId, variable.name);
      toast.success(t("deleted", { name: variable.name }));
    });
  }

  const variables = listing.variables;
  const hasEscrow = variables.some((v) => v.escrow);
  const hasMasked = variables.some((v) => v.kind !== "plain");

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          {hasMasked && (
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={onReveal}
            >
              {busy === "reveal" ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : revealed ? (
                <EyeOff data-icon="inline-start" />
              ) : (
                <Eye data-icon="inline-start" />
              )}
              {t(revealed ? "hideValues" : "revealValues")}
            </Button>
          )}
          {canWrite && (
            <Button
              variant="outline"
              disabled={busy !== null || !listing.hasApp}
              title={listing.hasApp ? undefined : t("noAppHint")}
              onClick={onApplyTemplate}
            >
              {busy === "template" ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <ListPlus data-icon="inline-start" />
              )}
              {t("applyTemplate")}
            </Button>
          )}
          {canWrite && (
            <Button onClick={() => setForm({ variable: null })}>
              <Plus data-icon="inline-start" />
              {t("add")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {hasEscrow && (
          <Alert>
            <Lock />
            <AlertDescription>{t("escrowWarning")}</AlertDescription>
          </Alert>
        )}

        {variables.length === 0 ? (
          <div className="rounded-lg border bg-card">
            <EmptyState
              icon={KeyRound}
              title={t("emptyTitle")}
              description={t("emptyDescription")}
            />
          </div>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colKind")}</TableHead>
                  <TableHead>{t("colValue")}</TableHead>
                  <TableHead>{t("colUpdated")}</TableHead>
                  {canWrite && (
                    <TableHead>
                      <span className="sr-only">{tCommon("actions")}</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {variables.map((variable) => (
                  <VariableTableRow
                    key={variable.name}
                    variable={variable}
                    revealedValue={revealed?.get(variable.name) ?? null}
                    busy={busy !== null}
                    canWrite={canWrite}
                    onEdit={() => setForm({ variable })}
                    onRegenerate={() => void onRegenerate(variable)}
                    onDelete={() => void onDelete(variable)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <VariableFormDialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        environmentId={environmentId}
        variable={form?.variable ?? null}
        canClearEscrow={canClearEscrow}
      />
    </>
  );
}

function VariableTableRow({
  variable,
  revealedValue,
  busy,
  canWrite,
  onEdit,
  onRegenerate,
  onDelete,
}: {
  variable: VariableRow;
  revealedValue: string | null;
  busy: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("variables");
  const shown = variable.value ?? revealedValue;

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <code className="font-mono text-sm">{variable.name}</code>
          {variable.escrow && (
            <Badge variant="outline">
              <Lock data-icon="inline-start" />
              {t("escrow")}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={variable.kind === "plain" ? "outline" : "secondary"}>
          {t(`kind.${variable.kind}`)}
        </Badge>
      </TableCell>
      <TableCell className="max-w-md">
        {shown !== null ? (
          <div className="flex items-center gap-1">
            <code className="font-mono text-sm truncate" title={shown}>
              {shown === "" ? (
                <span className="italic text-muted-foreground">
                  {t("emptyValue")}
                </span>
              ) : (
                shown
              )}
            </code>
            {variable.value === null && shown !== "" && (
              <CopyButton value={shown} />
            )}
          </div>
        ) : (
          <span className="font-mono text-sm text-muted-foreground">
            {MASK}
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        <span className="flex flex-col">
          <span>{variable.updatedByName ?? t("updatedByUnknown")}</span>
          <RelativeTime date={variable.updatedAt} />
        </span>
      </TableCell>
      {canWrite && (
        <TableCell>
          <RowActions
            label={t("rowActions", { name: variable.name })}
            disabled={busy}
            primary={{ label: t("edit"), icon: Pencil, onSelect: onEdit }}
            items={[
              ...(variable.kind === "generated"
                ? [
                    {
                      label: t("regenerate"),
                      icon: RefreshCw,
                      onSelect: onRegenerate,
                      disabled: variable.escrow,
                      disabledReason: variable.escrow
                        ? t("escrowLocked")
                        : undefined,
                    },
                  ]
                : []),
              {
                label: t("delete"),
                icon: Trash2,
                onSelect: onDelete,
                destructive: true,
                disabled: variable.escrow,
                disabledReason: variable.escrow ? t("escrowLocked") : undefined,
              },
            ]}
          />
        </TableCell>
      )}
    </TableRow>
  );
}
