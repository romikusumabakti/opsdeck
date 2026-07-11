"use client";

import { Trash2, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addProjectMember,
  type ProjectMemberRow,
  removeProjectMember,
  updateProjectMemberRole,
} from "@/actions/project-members";
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
import { useRouter } from "@/i18n/navigation";
import {
  ROLE_ADMIN,
  ROLE_MAINTAINER,
  ROLE_MEMBER,
  ROLE_VIEWER,
  type UserRole,
} from "@/lib/roles";

const ROLES: UserRole[] = [
  ROLE_VIEWER,
  ROLE_MEMBER,
  ROLE_MAINTAINER,
  ROLE_ADMIN,
];

export function ProjectMembersClient({
  projectId,
  initialMembers,
  assignableUsers,
}: {
  projectId: string;
  initialMembers: ProjectMemberRow[];
  assignableUsers: { id: string; name: string }[];
}) {
  const t = useTranslations("projectMembers");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [addUserId, setAddUserId] = useState<string>("");
  const [addRole, setAddRole] = useState<UserRole>(ROLE_MEMBER);

  // Only offer users who aren't already members in the add picker.
  const candidates = useMemo(() => {
    const taken = new Set(initialMembers.map((m) => m.userId));
    return assignableUsers.filter((u) => !taken.has(u.id));
  }, [assignableUsers, initialMembers]);

  function run(action: () => Promise<{ success: boolean; message?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.success) {
        if (result.message) toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message ?? t("errorAddFailed"));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Add member */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
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
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={addRole}
          onValueChange={(v) => setAddRole(v as UserRole)}
          disabled={isPending}
        >
          <SelectTrigger className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`role.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={!addUserId || isPending}
          onClick={() => {
            run(() =>
              addProjectMember({ projectId, userId: addUserId, role: addRole })
            );
            setAddUserId("");
            setAddRole(ROLE_MEMBER);
          }}
        >
          <UserPlus className="size-4" />
          {t("add")}
        </Button>
      </div>

      {/* Members table */}
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
                  <div className="flex flex-col">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.email}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Select
                    value={m.role}
                    disabled={isPending}
                    onValueChange={(v) => {
                      if (!v) return;
                      run(() =>
                        updateProjectMemberRole({
                          projectId,
                          userId: m.userId,
                          role: v,
                        })
                      );
                    }}
                  >
                    <SelectTrigger className="min-w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(`role.${r}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={isPending}
                    aria-label={t("remove")}
                    onClick={() =>
                      run(() =>
                        removeProjectMember({ projectId, userId: m.userId })
                      )
                    }
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
