import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
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
import { listAppsQuery } from "@/web/api/apps";
import { ApiError } from "@/web/api/client";
import {
  deleteVariableTemplate,
  listVariableTemplatesQuery,
  type VariableTemplateRow,
} from "@/web/api/variables";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { TemplateFormDialog } from "./-components/apps/template-form-dialog";

// The variables every environment of the app's services expects (each
// service's .env template; an environment merges those of the services it
// deploys). Org integration:manage, as the API checks. Task 4 moves this to
// the service page.
export const Route = createFileRoute(
  "/$locale/_app/admin/repositories/$appKey/variables"
)({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ params: { appKey }, context: { queryClient } }) => {
    const apps = await queryClient.query(listAppsQuery());
    const app = apps.find((a) => a.appKey === appKey);
    if (!app) throw notFound();
    await Promise.all(
      app.components.map((c) =>
        orNotFound(
          loaderQuery(queryClient, listVariableTemplatesQuery(c.componentKey))
        )
      )
    );
  },
  component: VariableTemplatesPage,
});

type FormState = { template: VariableTemplateRow | null } | null;

function VariableTemplatesPage() {
  const { appKey } = Route.useParams();
  const t = useTranslations("variableTemplates");
  const app = useSuspenseQuery(listAppsQuery()).data.find(
    (a) => a.appKey === appKey
  );
  if (!app) throw notFound();
  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { app: appKey })}
      />
      <div className="flex flex-col gap-6">
        {app.components.map((c) => (
          <ServiceTemplates
            key={c.componentKey}
            componentKey={c.componentKey}
          />
        ))}
      </div>
    </>
  );
}

/** One service's templates. */
function ServiceTemplates({ componentKey }: { componentKey: string }) {
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
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-sm font-medium">{componentKey}</h2>
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
