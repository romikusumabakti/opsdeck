import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  createDatabaseHost,
  type DatabaseHostRow,
  deleteDatabaseHost,
} from "@/web/api/database-hosts";

const DEFAULT_BACKUP_PATH = "/var/lib/postgresql/backups";

/** Registers a Postgres container found by the preflight as a database host. */
export function RegisterDatabaseHostButton({
  serverId,
  container,
}: {
  serverId: string;
  container: string;
}) {
  const t = useTranslations("serverPreflight");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [containerName, setContainerName] = useState(container);
  const [backupPath, setBackupPath] = useState(DEFAULT_BACKUP_PATH);
  const [label, setLabel] = useState(container);

  const register = useMutation({
    mutationFn: () =>
      createDatabaseHost({ serverId, containerName, backupPath, label }),
    onSuccess: async (host) => {
      toast.success(t("hostRegistered", { label: host.label }));
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["databaseHosts"] });
    },
    onError: (error) => toast.error(error.message || t("registerFailed")),
  });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Plus data-icon="inline-start" />
        {t("register")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("registerTitle")}</DialogTitle>
            <DialogDescription>{t("registerDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              register.mutate();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="db-host-container">
                  {t("containerName")}
                </FieldLabel>
                <Input
                  id="db-host-container"
                  className="font-mono"
                  value={containerName}
                  onChange={(e) => setContainerName(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="db-host-backup-path">
                  {t("backupPath")}
                </FieldLabel>
                <Input
                  id="db-host-backup-path"
                  className="font-mono"
                  value={backupPath}
                  onChange={(e) => setBackupPath(e.target.value)}
                  required
                />
                <FieldDescription>{t("backupPathHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="db-host-label">{t("label")}</FieldLabel>
                <Input
                  id="db-host-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={register.isPending}>
                {register.isPending ? t("registering") : t("register")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The registered database hosts of a server, each with a delete action. */
export function DatabaseHostList({ hosts }: { hosts: DatabaseHostRow[] }) {
  const t = useTranslations("serverPreflight");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (host: DatabaseHostRow) => deleteDatabaseHost(host.id),
    onSuccess: async (_, host) => {
      toast.success(t("hostDeleted", { label: host.label }));
      await queryClient.invalidateQueries({ queryKey: ["databaseHosts"] });
    },
    onError: (error) => toast.error(error.message || t("deleteFailed")),
  });

  if (hosts.length === 0) return <>{t("hostsNone")}</>;
  return (
    <ul className="flex flex-col gap-1">
      {hosts.map((host) => (
        <li key={host.id} className="flex items-center gap-2">
          <span>{host.label}</span>
          <span className="font-mono text-muted-foreground">
            {host.containerName} · {host.backupPath}
          </span>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("deleteHost", { label: host.label })}
                  disabled={remove.isPending}
                />
              }
            >
              <Trash2 />
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("deleteHostTitle", { label: host.label })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deleteHostBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => remove.mutate(host)}
                >
                  {tCommon("delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </li>
      ))}
    </ul>
  );
}
