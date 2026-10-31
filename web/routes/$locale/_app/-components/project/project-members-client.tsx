import { Trash2, UserPlus } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipHint } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import { UserName } from "@/components/user/user-name";
import { PROJECT_ROLES, type ProjectRole } from "@/lib/permissions";
import {
  addProjectMember,
  type OrgWideAccessRow,
  type ProjectMemberRow,
  removeProjectMember,
  updateProjectMemberRole,
} from "@/web/api/project-members";

// A project-role picker whose options explain what each role may do. The
// explicit `items` keeps the closed trigger to the bare role name.
function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("projectMembers");
  const items = Object.fromEntries(
    PROJECT_ROLES.map((r) => [r, t(`role.${r}`)])
  );
  return (
    <Select
      value={value}
      items={items}
      disabled={disabled}
      onValueChange={(v) => v && onChange(v as ProjectRole)}
    >
      <SelectTrigger className="min-w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-80">
        {PROJECT_ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            <span className="flex flex-col gap-0.5">
              <span>{t(`role.${r}`)}</span>
              <span className="text-xs text-muted-foreground whitespace-normal">
                {t(`roleDescription.${r}`)}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ProjectMembersClient({
  projectId,
  projectName,
  initialMembers,
  memberCandidates,
  orgWideAccess,
}: {
  projectId: string;
  projectName: string;
  initialMembers: ProjectMemberRow[];
  memberCandidates: { id: string; name: string; email: string }[];
  orgWideAccess: OrgWideAccessRow[];
}) {
  const t = useTranslations("projectMembers");
  const tOrgRole = useTranslations("users.role");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();
  const [addUserId, setAddUserId] = useState<string>("");
  const [addRole, setAddRole] = useState<ProjectRole>("contributor");

  const memberIds = useMemo(
    () => new Set(initialMembers.map((m) => m.userId)),
    [initialMembers]
  );
  // Only offer users who aren't already members in the add picker.
  const candidates = useMemo(
    () => memberCandidates.filter((u) => !memberIds.has(u.id)),
    [memberCandidates, memberIds]
  );
  // Org-wide access for people who aren't already listed as members.
  const implicitOnly = useMemo(
    () => orgWideAccess.filter((u) => !memberIds.has(u.userId)),
    [orgWideAccess, memberIds]
  );

  function run(action: () => Promise<{ success: boolean; message?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.success) {
        if (result.message) toast.success(result.message);
      } else {
        toast.error(result.message ?? t("errorAddFailed"));
      }
    });
  }

  async function confirmRemove(member: ProjectMemberRow) {
    const ok = await dialog.confirm({
      title: t("removeConfirmTitle", {
        name: member.name,
        project: projectName,
      }),
      description: t("removeConfirmDescription"),
      confirmText: t("remove"),
      destructive: true,
    });
    if (ok) {
      run(() => removeProjectMember({ projectId, userId: member.userId }));
    }
  }

  return (
    // The add-member row stays put; only the roster scrolls.
    <div className="flex flex-1 min-h-0 flex-col gap-4">
      {/* Add member */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <Select
          value={addUserId}
          onValueChange={(v) => setAddUserId(v ?? "")}
          disabled={candidates.length === 0 || isPending}
        >
          <SelectTrigger className="min-w-52">
            <SelectValue placeholder={t("selectUser")} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
                <span className="text-muted-foreground text-xs">{u.email}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RoleSelect
          value={addRole}
          onChange={setAddRole}
          disabled={isPending}
        />
        <Button
          disabled={!addUserId || isPending}
          onClick={() => {
            run(() =>
              addProjectMember({ projectId, userId: addUserId, role: addRole })
            );
            setAddUserId("");
            setAddRole("contributor");
          }}
        >
          <UserPlus className="size-4" />
          {t("add")}
        </Button>
      </div>

      {/* One scroll box below the add row: the roster, then the org-wide
          access after its last row. The table container must not scroll
          itself (overflow-visible), so the sticky header pins to this box. */}
      <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto">
        {initialMembers.length === 0 ? (
          <EmptyState title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <Table containerClassName="overflow-visible">
            <TableHeader className="sticky top-0 z-10 [&_th]:bg-background [&_th]:border-b">
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colRole")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialMembers.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell>
                    {/* Avatar beside a name-over-email stack, so both lines
                        share one left edge. */}
                    <div className="flex items-center gap-3">
                      <UserAvatar
                        user={{ id: m.userId, name: m.name, image: m.image }}
                        size="md"
                      />
                      <div className="flex min-w-0 flex-col">
                        <UserName
                          user={{ id: m.userId, name: m.name, image: m.image }}
                          className="font-medium"
                        />
                        <span className="truncate text-xs text-muted-foreground">
                          {m.email}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleSelect
                      value={m.role}
                      disabled={isPending}
                      onChange={(role) =>
                        run(() =>
                          updateProjectMemberRole({
                            projectId,
                            userId: m.userId,
                            role,
                          })
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {/* Muted until hovered: a row of red bins reads as alarm. */}
                    <TooltipHint label={t("removeMember", { name: m.name })}>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        aria-label={t("removeMember", { name: m.name })}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => confirmRemove(m)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TooltipHint>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Read-only: access that comes from the org role, not a membership. */}
        {implicitOnly.length > 0 && (
          <section className="shrink-0 flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-col gap-0.5">
              <h3 className="text-sm font-medium">{t("orgAccessTitle")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("orgAccessDescription")}
              </p>
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-2">
              {implicitOnly.map((u) => (
                <li key={u.userId} className="flex items-center gap-2 text-sm">
                  <UserName
                    user={{ id: u.userId, name: u.name, image: u.image }}
                    avatar="sm"
                  />
                  <Badge variant="outline">
                    {tOrgRole(u.orgRole)} · {t(`role.${u.role}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
