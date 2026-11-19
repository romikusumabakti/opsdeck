import { useSuspenseQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { TooltipHint } from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import { branchSchema } from "@/lib/deploy/validation";
import { branchChip } from "@/lib/setup/source-branch";
import { cn } from "@/lib/utils";
import {
  addProjectSource,
  listProjectSourcesQuery,
  type ProjectSourceRow,
  removeProjectSource,
  setComponentBranch,
} from "@/web/api/project-sources";
import { listServicesQuery } from "@/web/api/service-catalog";

type Project = { id: string; key: string };
type ActionResult = { success: boolean; message?: string };

/**
 * The Sources tab of Project settings: the services the project deploys, each
 * one's default branch, and the branch every environment really uses. Adding
 * a service only picks from the registered ones; a new repository is
 * registered by creating an environment for it.
 */
export function ProjectSourcesTab({
  project,
  canManageApps,
}: {
  project: Project;
  /** environment:create on the project: Add app and Remove. */
  canManageApps: boolean;
}) {
  const t = useTranslations("projectSources");
  const sources = useSuspenseQuery(listProjectSourcesQuery(project.id)).data;
  const services = useSuspenseQuery(listServicesQuery()).data;
  const [addOpen, setAddOpen] = useState(false);
  const addable = useMemo(() => {
    const taken = new Set(sources.map((s) => s.componentKey));
    return services.filter((service) => !taken.has(service.key));
  }, [services, sources]);
  const newEnvironment = (
    <Link
      href={`/${project.key}/environments/new`}
      className={buttonVariants({ variant: "outline" })}
    >
      {t("openNewEnvironment")}
    </Link>
  );
  const addButton = canManageApps && (
    <Button onClick={() => setAddOpen(true)}>
      <Plus className="size-4" />
      {t("addApp")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      {sources.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {addButton}
              {newEnvironment}
            </div>
          }
        />
      ) : (
        <>
          {addButton && <div className="flex justify-end">{addButton}</div>}
          {sources.map((source) => (
            <SourceCard
              key={source.componentKey}
              project={project}
              source={source}
              canManageApps={canManageApps}
            />
          ))}
        </>
      )}
      {canManageApps && (
        <AddServiceDialog
          project={project}
          services={addable}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      )}
    </div>
  );
}

/** Runs a mutation and reports its outcome as a toast. */
function useRun() {
  const t = useTranslations("projectSources");
  const [isPending, startTransition] = useTransition();
  function run(action: () => Promise<ActionResult>, onDone?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (result.success) {
        if (result.message) toast.success(result.message);
        onDone?.();
      } else {
        toast.error(result.message ?? t("actionFailed"));
      }
    });
  }
  return { run, isPending };
}

function SourceCard({
  project,
  source,
  canManageApps,
}: {
  project: Project;
  source: ProjectSourceRow;
  canManageApps: boolean;
}) {
  const t = useTranslations("projectSources");
  const dialog = useDialog();
  const { run, isPending } = useRun();

  async function confirmRemove() {
    const ok = await dialog.confirm({
      title: t("removeConfirmTitle", {
        app: source.componentKey,
        project: project.key,
      }),
      description: t("removeConfirmDescription"),
      confirmText: t("remove"),
      destructive: true,
    });
    if (ok) {
      run(() =>
        removeProjectSource({
          projectId: project.id,
          componentKey: source.componentKey,
        })
      );
    }
  }

  const removeButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={source.inUse || isPending}
      onClick={confirmRemove}
    >
      <Trash2 className="size-4" />
      {t("remove")}
    </Button>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <CardTitle className="font-mono">{source.componentKey}</CardTitle>
        {canManageApps && (
          <div className="ml-auto">
            {source.inUse ? (
              // A disabled button gets no pointer events, so the span hosts
              // the tooltip; it takes focus so a keyboard user reads it too.
              <TooltipHint label={t("removeInUse")}>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus target for the tooltip of a disabled button */}
                <span tabIndex={0}>{removeButton}</span>
              </TooltipHint>
            ) : (
              removeButton
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col">
        <ComponentRow project={project} component={source} />
      </CardContent>
    </Card>
  );
}

function ComponentRow({
  project,
  component,
}: {
  project: Project;
  component: ProjectSourceRow;
}) {
  const t = useTranslations("projectSources");
  const { run, isPending } = useRun();
  const saved = component.defaultBranch ?? "";
  const [draft, setDraft] = useState(saved);
  const [syncedFrom, setSyncedFrom] = useState(saved);
  // Follow the stored value after a save or a refetch.
  if (syncedFrom !== saved) {
    setSyncedFrom(saved);
    setDraft(saved);
  }
  const trimmed = draft.trim();
  const valid = branchSchema.safeParse(trimmed).success;
  const canSave = trimmed !== saved && valid && !isPending;
  const effectiveDefault = component.defaultBranch ?? component.fallbackBranch;

  return (
    <div className="flex flex-col gap-3">
      <span className="font-mono text-sm">{component.repoFullName}</span>
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          run(() =>
            setComponentBranch({
              projectId: project.id,
              componentKey: component.componentKey,
              branch: trimmed,
            })
          );
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={component.fallbackBranch}
            aria-label={t("defaultBranch")}
            aria-invalid={trimmed !== "" && !valid ? true : undefined}
            className="max-w-xs font-mono"
          />
          <Button type="submit" disabled={!canSave}>
            {t("save")}
          </Button>
        </div>
        {trimmed !== "" && !valid && (
          <p className="text-xs text-destructive">{t("invalidBranch")}</p>
        )}
      </form>
      {component.environments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noEnvironments")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {component.environments.map((env) => {
            const chip = branchChip(env.sourceBranch, effectiveDefault);
            return (
              <li key={env.id}>
                <Link
                  href={`/${project.key}/${env.slug}/settings?tab=source`}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted",
                    chip === "noTarget" && "text-muted-foreground"
                  )}
                >
                  {env.name} ·{" "}
                  {env.sourceBranch === null ? t("noTarget") : env.sourceBranch}
                  {chip === "differs" && (
                    <Badge variant="outline">{t("differs")}</Badge>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddServiceDialog({
  project,
  services,
  open,
  onOpenChange,
}: {
  project: Project;
  services: { key: string; repoFullName: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("projectSources");
  const { run, isPending } = useRun();
  const [key, setKey] = useState<string | null>(null);
  const byKey = useMemo(
    () => new Map(services.map((s) => [s.key, s])),
    [services]
  );
  const picked = key === null ? undefined : byKey.get(key);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setKey(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addAppTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Combobox
            autoHighlight
            items={services.map((s) => s.key)}
            value={key}
            onValueChange={setKey}
            itemToStringLabel={(k: string | null) => {
              const service = k === null ? undefined : byKey.get(k);
              return service ? `${service.key} ${service.repoFullName}` : "";
            }}
          >
            <ComboboxTrigger
              render={
                <Button
                  variant="outline"
                  className="h-8 w-full justify-between font-normal"
                  aria-label={t("selectApp")}
                />
              }
            >
              {picked ? (
                <span className="truncate font-mono">{picked.key}</span>
              ) : (
                <span className="truncate text-muted-foreground">
                  {t("selectApp")}
                </span>
              )}
            </ComboboxTrigger>
            <ComboboxContent>
              <ComboboxEmpty>{t("noAppsToAdd")}</ComboboxEmpty>
              <ComboboxList>
                {(k: string) => {
                  const service = byKey.get(k);
                  if (!service) return null;
                  return (
                    <ComboboxItem key={service.key} value={service.key}>
                      <span className="truncate font-mono">{service.key}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {service.repoFullName}
                      </span>
                    </ComboboxItem>
                  );
                }}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <p className="text-sm text-muted-foreground">
            {t("registerHint")}{" "}
            <Link
              href={`/${project.key}/environments/new`}
              className="underline underline-offset-4"
            >
              {t("openNewEnvironment")}
            </Link>
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={key === null || isPending}
            onClick={() => {
              if (key === null) return;
              run(
                () =>
                  addProjectSource({
                    projectId: project.id,
                    componentKey: key,
                  }),
                () => onOpenChange(false)
              );
            }}
          >
            {t("add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
