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
import { listAppsQuery } from "@/web/api/apps";
import {
  addProjectSource,
  listProjectSourcesQuery,
  type ProjectSourceRow,
  removeProjectSource,
  setComponentBranch,
} from "@/web/api/project-sources";

type Project = { id: string; key: string };
type Component = ProjectSourceRow["components"][number];
type ActionResult = { success: boolean; message?: string };

/**
 * The Sources tab of Project settings: the apps the project deploys, each
 * component's default branch, and the branch every environment really uses.
 * Adding an app only picks from the catalog; a new repository is registered
 * by creating an environment for it.
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
  const apps = useSuspenseQuery(listAppsQuery()).data;
  const [addOpen, setAddOpen] = useState(false);
  const addable = useMemo(() => {
    const taken = new Set(sources.map((s) => s.appId));
    return apps.filter((app) => !taken.has(app.id));
  }, [apps, sources]);
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
              key={source.appId}
              project={project}
              source={source}
              canManageApps={canManageApps}
            />
          ))}
        </>
      )}
      {canManageApps && (
        <AddAppDialog
          project={project}
          apps={addable}
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
        app: source.name,
        project: project.key,
      }),
      description: t("removeConfirmDescription"),
      confirmText: t("remove"),
      destructive: true,
    });
    if (ok) {
      run(() =>
        removeProjectSource({ projectId: project.id, appId: source.appId })
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
        <CardTitle>{source.name}</CardTitle>
        <Badge variant="secondary" className="font-mono">
          {source.appKey}
        </Badge>
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
      <CardContent className="flex flex-col divide-y">
        {source.components.map((component) => (
          <ComponentRow
            key={component.componentKey}
            project={project}
            component={component}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ComponentRow({
  project,
  component,
}: {
  project: Project;
  component: Component;
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
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
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

function AddAppDialog({
  project,
  apps,
  open,
  onOpenChange,
}: {
  project: Project;
  apps: { id: string; appKey: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("projectSources");
  const { run, isPending } = useRun();
  const [appId, setAppId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const picked = appId === null ? undefined : byId.get(appId);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setAppId(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addAppTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Combobox
            autoHighlight
            items={apps.map((a) => a.id)}
            value={appId}
            onValueChange={setAppId}
            itemToStringLabel={(id: string | null) => {
              const app = id === null ? undefined : byId.get(id);
              return app ? `${app.name} ${app.appKey}` : "";
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
                <span className="truncate">{picked.name}</span>
              ) : (
                <span className="truncate text-muted-foreground">
                  {t("selectApp")}
                </span>
              )}
            </ComboboxTrigger>
            <ComboboxContent>
              <ComboboxEmpty>{t("noAppsToAdd")}</ComboboxEmpty>
              <ComboboxList>
                {(id: string) => {
                  const app = byId.get(id);
                  if (!app) return null;
                  return (
                    <ComboboxItem key={app.id} value={app.id}>
                      <span className="truncate">{app.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {app.appKey}
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
            disabled={appId === null || isPending}
            onClick={() => {
              if (appId === null) return;
              run(
                () => addProjectSource({ projectId: project.id, appId }),
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
