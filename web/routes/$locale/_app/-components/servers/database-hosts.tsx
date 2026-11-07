import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
  updateDatabaseHostNetwork,
} from "@/web/api/database-hosts";

const DEFAULT_BACKUP_PATH = "/var/lib/postgresql/backups";
// Same rule as the server (lib/setup/network).
const NETWORK_PATTERN = "[a-zA-Z0-9][a-zA-Z0-9_.\\-]{0,127}";

/** Sets or clears the Docker network of an existing database host. */
function EditNetworkButton({ host }: { host: DatabaseHostRow }) {
  const t = useTranslations("serverPreflight");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [network, setNetwork] = useState(host.network ?? "");

  const save = useMutation({
    mutationFn: () =>
      updateDatabaseHostNetwork(host.id, network.trim() || null),
    onSuccess: async () => {
      toast.success(t("networkSaved", { label: host.label }));
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["databaseHosts"] });
    },
    onError: (error) => toast.error(error.message || t("networkSaveFailed")),
  });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("editNetwork", { label: host.label })}
        onClick={() => {
          setNetwork(host.network ?? "");
          setOpen(true);
        }}
      >
        <Pencil />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("editNetworkTitle", { label: host.label })}
            </DialogTitle>
            <DialogDescription>{t("editNetworkDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`db-host-network-${host.id}`}>
                  {t("network")}
                </FieldLabel>
                <Input
                  id={`db-host-network-${host.id}`}
                  className="font-mono"
                  value={network}
                  pattern={NETWORK_PATTERN}
                  maxLength={128}
                  onChange={(e) => setNetwork(e.target.value)}
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
              <Button type="submit" disabled={save.isPending}>
                {tCommon("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

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
  const [network, setNetwork] = useState("");

  const register = useMutation({
    mutationFn: () =>
      createDatabaseHost({
        serverId,
        containerName,
        backupPath,
        label,
        // Blank: the server reads the container's first user-defined network.
        ...(network.trim() ? { network: network.trim() } : {}),
      }),
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
              <Field>
                <FieldLabel htmlFor="db-host-network">
                  {t("network")}
                </FieldLabel>
                <Input
                  id="db-host-network"
                  className="font-mono"
                  value={network}
                  placeholder={t("networkPlaceholder")}
                  pattern={NETWORK_PATTERN}
                  maxLength={128}
                  onChange={(e) => setNetwork(e.target.value)}
                />
                <FieldDescription>{t("networkHint")}</FieldDescription>
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
            {host.containerName}
          </span>
          <span className="font-mono text-muted-foreground">
            {host.network ?? t("networkNone")}
          </span>
          <EditNetworkButton host={host} />
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
