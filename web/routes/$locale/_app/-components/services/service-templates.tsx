import { useSuspenseQuery } from "@tanstack/react-query";
import { ListTree, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
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
import { ApiError } from "@/web/api/client";
import {
  deleteVariableTemplate,
  listVariableTemplatesQuery,
  type VariableTemplateRow,
} from "@/web/api/variables";
import { TemplateFormDialog } from "./template-form-dialog";

type FormState = { template: VariableTemplateRow | null } | null;

/**
 * A service's variable templates: what every environment deploying it
 * expects in its .env (an environment merges those of the services it
 * deploys). Org integration:manage, as the API checks.
 */
export function ServiceTemplates({ componentKey }: { componentKey: string }) {
  const t = useTranslations("variableTemplates");
  const tVariables = useTranslations("variables");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const templates = useSuspenseQuery(
    listVariableTemplatesQuery(componentKey)
  ).data;
  const [form, setForm] = React.useState<FormState>(null);
  const [busy, setBusy] = React.useState(false);

  async function onDelete(template: VariableTemplateRow) {
    const ok = await dialog.confirm({
      title: t("deleteConfirmTitle", { name: template.name }),
      description: t("deleteConfirmDescription"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteVariableTemplate(componentKey, template.name);
      toast.success(t("deleted", { name: template.name }));
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : tCommon("errorGeneric")
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="templates-title">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id="templates-title" className="text-base font-medium">
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button onClick={() => setForm({ template: null })}>
          <Plus data-icon="inline-start" />
          {t("add")}
        </Button>
      </div>
      {templates.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={ListTree}
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
                <TableHead>{t("colDefault")}</TableHead>
                <TableHead>{t("colDescription")}</TableHead>
                <TableHead>
                  <span className="sr-only">{tCommon("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-sm">{template.name}</code>
                      {template.required && (
                        <Badge variant="secondary">{t("required")}</Badge>
                      )}
                      {template.escrow && (
                        <Badge variant="outline">
                          <Lock data-icon="inline-start" />
                          {tVariables("escrow")}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        template.kind === "plain" ? "outline" : "secondary"
                      }
                    >
                      {tVariables(`kind.${template.kind}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {template.kind === "plain"
                      ? (template.defaultValue ?? "—")
                      : template.kind === "generated"
                        ? t("length", {
                            length: template.generatedLength ?? 32,
                          })
                        : "—"}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {template.description ?? ""}
                  </TableCell>
                  <TableCell>
                    <RowActions
                      label={tVariables("rowActions", { name: template.name })}
                      disabled={busy}
                      primary={{
                        label: tVariables("edit"),
                        icon: Pencil,
                        onSelect: () => setForm({ template }),
                      }}
                      items={[
                        {
                          label: tVariables("delete"),
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => void onDelete(template),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <TemplateFormDialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        componentKey={componentKey}
        template={form?.template ?? null}
      />
    </section>
  );
}
