import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  GitMerge,
  Layers,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { SearchSelect } from "@/components/search-select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGroupErrorMessage } from "@/hooks/use-group-error-message";
import {
  createGroup,
  deleteGroup,
  listGroupsQuery,
  mergeGroups,
  type ProjectGroupSummary,
  renameGroup,
  reorderGroup,
} from "@/web/api/project-groups";

type Group = ProjectGroupSummary;

type Pending =
  | { type: "merge"; from: Group; into: string | null }
  | { type: "delete"; group: Group };

/** The "Manage groups" button of the Projects header, with its dialog. */
export function ProjectGroupsButton() {
  const t = useTranslations("projectGroups");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Layers className="size-4" />
        {t("manage")}
      </Button>
      <ProjectGroupsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

// Order, rename, merge, delete and create project groups. Every action calls
// its endpoint, then refetches the groups and the projects (their grouping).
export function ProjectGroupsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("projectGroups");
  const queryClient = useQueryClient();
  const errorMessage = useGroupErrorMessage();
  const groups = useQuery({ ...listGroupsQuery(), enabled: open }).data ?? [];
  const [renaming, setRenaming] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  const run = useMutation({
    mutationFn: async ({
      action,
    }: {
      action: () => Promise<unknown>;
      done: string;
    }) => action(),
    onSuccess: async (_data, { done }) => {
      toast.success(done);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-groups"] }),
        queryClient.invalidateQueries({ queryKey: ["project-catalog"] }),
      ]);
    },
    onError: (error) => toast.error(errorMessage(error, t("failed"))),
  });

  function act(
    action: () => Promise<unknown>,
    done: string,
    then?: () => void
  ) {
    run.mutate({ action, done }, { onSuccess: then });
  }

  function move(index: number, direction: -1 | 1) {
    const group = groups[index];
    const neighbour = groups[index + direction];
    if (!(group && neighbour)) return;
    act(
      () =>
        reorderGroup(
          group.id,
          direction === -1 ? { before: neighbour.id } : { after: neighbour.id }
        ),
      t("moved")
    );
  }

  const busy = run.isPending;
  const mergeTargets =
    pending?.type === "merge"
      ? groups
          .filter((g) => g.id !== pending.from.id)
          .map((g) => ({ value: g.id, label: g.name }))
      : [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-lg border">
              {groups.map((group, index) => (
                <li
                  key={group.id}
                  className="flex items-center gap-1 px-3 py-2"
                >
                  {renaming?.id === group.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        act(
                          () => renameGroup(group.id, renaming.name),
                          t("renamed"),
                          () => setRenaming(null)
                        );
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label={t("renameInput")}
                        value={renaming.name}
                        maxLength={80}
                        onChange={(e) =>
                          setRenaming({ id: group.id, name: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setRenaming(null);
                          }
                        }}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={busy || renaming.name.trim() === ""}
                      >
                        {t("renameSave")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(null)}
                      >
                        {t("renameCancel")}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {group.name}
                      </span>
                      <span className="shrink-0 pe-2 text-xs text-muted-foreground">
                        {t("projectCount", { count: group.projectCount })}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("moveUp", { name: group.name })}
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("moveDown", { name: group.name })}
                        disabled={busy || index === groups.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("rename", { name: group.name })}
                        onClick={() =>
                          setRenaming({ id: group.id, name: group.name })
                        }
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("mergeInto", { name: group.name })}
                        disabled={groups.length < 2}
                        onClick={() =>
                          setPending({ type: "merge", from: group, into: null })
                        }
                      >
                        <GitMerge />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("delete", { name: group.name })}
                        onClick={() => setPending({ type: "delete", group })}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(
                () => createGroup(newName),
                t("created"),
                () => setNewName("")
              );
            }}
          >
            <Input
              aria-label={t("newName")}
              placeholder={t("newName")}
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button type="submit" disabled={busy || newName.trim() === ""}>
              <Plus className="size-4" />
              {t("create")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pending?.type === "merge"}
        onOpenChange={(next) => !next && setPending(null)}
      >
        <AlertDialogContent>
          {pending?.type === "merge" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("mergeInto", { name: pending.from.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("mergeConfirm", {
                    projects: pending.from.projectCount,
                    from: pending.from.name,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <SearchSelect
                aria-label={t("mergeTarget")}
                value={pending.into}
                onChange={(into) => setPending({ ...pending, into })}
                options={mergeTargets}
                placeholder={t("mergeTargetPlaceholder")}
              />
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy || pending.into === null}
                  onClick={() => {
                    const { from, into } = pending;
                    if (into === null) return;
                    act(() => mergeGroups(from.id, into), t("merged"));
                    setPending(null);
                  }}
                >
                  {t("mergeAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pending?.type === "delete"}
        onOpenChange={(next) => !next && setPending(null)}
      >
        <AlertDialogContent>
          {pending?.type === "delete" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("deleteTitle", { name: pending.group.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deleteDescription", {
                    projects: pending.group.projectCount,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    const { group } = pending;
                    act(() => deleteGroup(group.id), t("deleted"));
                    setPending(null);
                  }}
                >
                  {t("deleteAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
