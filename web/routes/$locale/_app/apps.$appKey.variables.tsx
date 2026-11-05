import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ListTree, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { PageHeader } from "@/components/page-header";
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
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { TemplateFormDialog } from "./-components/apps/template-form-dialog";

// The variables every environment of the app expects (its .env template).
// Org integration:manage, as the API checks.
export const Route = createFileRoute("/$locale/_app/apps/$appKey/variables")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ params: { appKey }, context: { queryClient } }) => {
    await orNotFound(
      loaderQuery(queryClient, listVariableTemplatesQuery(appKey))
    );
  },
  component: VariableTemplatesPage,
});

type FormState = { template: VariableTemplateRow | null } | null;

function VariableTemplatesPage() {
  const { appKey } = Route.useParams();
  const t = useTranslations("variableTemplates");
  const tVariables = useTranslations("variables");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const templates = useSuspenseQuery(listVariableTemplatesQuery(appKey)).data;
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
      await deleteVariableTemplate(appKey, template.name);
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
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { app: appKey })}
        action={
          <Button onClick={() => setForm({ template: null })}>
            <Plus data-icon="inline-start" />
            {t("add")}
          </Button>
        }
      />
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
                      <code className="font-mono text-xs">{template.name}</code>
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
                  <TableCell className="font-mono text-xs text-muted-foreground">
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
        appKey={appKey}
        template={form?.template ?? null}
      />
    </>
  );
}
