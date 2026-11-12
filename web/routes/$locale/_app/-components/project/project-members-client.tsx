import { useSuspenseQuery } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { PersonPicker } from "@/components/person-picker";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
import {
  addProjectMember,
  listMemberCandidatesQuery,
  listProjectMembersQuery,
  type ProjectMemberRow,
  removeProjectMember,
} from "@/web/api/project-members";
import { RoleBadge } from "../admin/users/user-badges";

/** The Members tab of Project settings: reads both lists, then the roster. */
export function ProjectMembersTab({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const members = useSuspenseQuery(listProjectMembersQuery(projectId)).data;
  const memberCandidates = useSuspenseQuery(
    listMemberCandidatesQuery(projectId)
  ).data;
  return (
    <ProjectMembersClient
      projectId={projectId}
      projectName={projectName}
      initialMembers={members}
      memberCandidates={memberCandidates}
    />
  );
}

export function ProjectMembersClient({
  projectId,
  projectName,
  initialMembers,
  memberCandidates,
}: {
  projectId: string;
  projectName: string;
  initialMembers: ProjectMemberRow[];
  memberCandidates: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  }[];
}) {
  const t = useTranslations("projectMembers");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();
  const [addUserId, setAddUserId] = useState<string>("");

  const memberIds = useMemo(
    () => new Set(initialMembers.map((m) => m.userId)),
    [initialMembers]
  );
  // Only offer users who aren't already members in the add picker.
  const candidates = useMemo(
    () => memberCandidates.filter((u) => !memberIds.has(u.id)),
    [memberCandidates, memberIds]
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
    <div className="flex flex-col gap-4">
      {/* Add member */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <PersonPicker
          people={candidates}
          value={addUserId || null}
          onChange={(id) => setAddUserId(id ?? "")}
          placeholder={t("selectUser")}
          aria-label={t("selectUser")}
          disabled={candidates.length === 0 || isPending}
          className="min-w-52"
        />
        <Button
          disabled={!addUserId || isPending}
          onClick={() => {
            run(() => addProjectMember({ projectId, userId: addUserId }));
            setAddUserId("");
          }}
        >
          <UserPlus className="size-4" />
          {t("add")}
        </Button>
      </div>

      <div>
        {initialMembers.length === 0 ? (
          <EmptyState title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <Table>
            <TableHeader>
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
                    {/* The global role, read-only: it is changed under
                        Admin → Users, not per project. */}
                    <RoleBadge role={m.orgRole} />
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
      </div>
    </div>
  );
}
