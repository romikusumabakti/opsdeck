"use client";

import { UserPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic } from "react";
import type { AccessMatrix as Matrix } from "@/actions/access";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { filterUsers, parseUsersTab, type UsersTab } from "@/lib/access";
import { AccessMatrix } from "./access-matrix";
import { InvitationsTable } from "./invitations-table";
import { InviteDialog } from "./invite-dialog";
import type {
  InvitationAction,
  InvitationRow,
  UserAction,
  UserFilterState,
  UserRow,
} from "./types";
import { UserFilters } from "./user-filters";
import { UsersTable } from "./users-table";

function reduceUsers(state: UserRow[], action: UserAction): UserRow[] {
  if (action.type === "remove") {
    return state.filter((u) => !action.ids.includes(u.id));
  }
  return state.map((u) => {
    if (u.id !== action.id) return u;
    switch (action.type) {
      case "updateRole":
        return { ...u, role: action.role };
      case "updateName":
        return { ...u, name: action.name };
      case "removeImage":
        return { ...u, image: null };
      default:
        // offboard: banned, with every membership removed.
        return { ...u, banned: true, projectCount: 0 };
    }
  });
}

function reduceInvitations(
  state: InvitationRow[],
  action: InvitationAction
): InvitationRow[] {
  if (action.type === "add") return [...state, action.invitation];
  if (action.type === "renew") {
    return state.map((inv) =>
      inv.id === action.id ? { ...inv, expiresAt: action.expiresAt } : inv
    );
  }
  return state.filter((inv) => !action.ids.includes(inv.id));
}

export function UsersClient({
  users,
  invitations,
  matrix,
  now,
  currentUserId,
  canInvite,
  canRename,
  canSetRole,
  canOffboard,
  canDelete,
}: {
  users: UserRow[];
  invitations: InvitationRow[];
  // Null when the viewer lacks audit:read; the Project access tab is hidden.
  matrix: Matrix | null;
  now: string;
  currentUserId: string;
  // Computed on the server with canOrg; the actions enforce the same checks.
  canInvite: boolean;
  canRename: boolean;
  canSetRole: boolean;
  canOffboard: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("users");
  const searchParams = useSearchParams();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [filters, setFilters] = React.useState<UserFilterState>({
    showBanned: false,
    inactiveOnly: false,
  });
  const nowDate = React.useMemo(() => new Date(now), [now]);
  const perms = React.useMemo(
    () => ({ canRename, canSetRole, canOffboard, canDelete }),
    [canRename, canSetRole, canOffboard, canDelete]
  );

  // Optimistic state lives here so every tab (and its count) reflects an edit
  // made on another; React rolls each back when its transition resolves.
  const [optimisticUsers, applyUserAction] = useOptimistic(users, reduceUsers);
  const [optimisticInvitations, applyInvitationAction] = useOptimistic(
    invitations,
    reduceInvitations
  );

  const visibleUsers = React.useMemo(
    () => filterUsers(optimisticUsers, { ...filters, now: nowDate }),
    [optimisticUsers, filters, nowDate]
  );
  const activeCount = optimisticUsers.filter((u) => !u.banned).length;

  // Split invitations by lifecycle so the "Pending" heading never lies: a link
  // past its expiry lives in its own "Expired" table (resend to renew), while
  // Pending only holds still-actionable invites.
  const nowMs = nowDate.getTime();
  const pendingInvitations = optimisticInvitations.filter(
    (inv) => new Date(inv.expiresAt).getTime() >= nowMs
  );
  const expiredInvitations = optimisticInvitations.filter(
    (inv) => new Date(inv.expiresAt).getTime() < nowMs
  );

  // Invitation tabs only appear when they have rows; Project access only with
  // audit:read. The active tab lives in `?tab=` so it survives reloads and
  // can be linked to (the old /admin/access redirects to `?tab=access`).
  const visibleTabs: UsersTab[] = [
    "users",
    ...(matrix ? (["access"] as const) : []),
    ...(pendingInvitations.length > 0 ? (["pending"] as const) : []),
    ...(expiredInvitations.length > 0 ? (["expired"] as const) : []),
  ];
  const tab = parseUsersTab(searchParams.get("tab"), visibleTabs);

  const onTabChange = React.useCallback((value: unknown) => {
    const params = new URLSearchParams(window.location.search);
    if (value === "users") params.delete("tab");
    else params.set("tab", String(value));
    const query = params.toString();
    // The native history API syncs with useSearchParams without a server
    // round-trip; replace rather than push so tabs don't pile up in history.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`
    );
  }, []);

  const filterBar = (idPrefix: string) => (
    <UserFilters idPrefix={idPrefix} value={filters} onChange={setFilters} />
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          canInvite ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-4" />
              {t("inviteCardTitle")}
            </Button>
          ) : undefined
        }
      />

      {canInvite && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          applyOptimistic={applyInvitationAction}
        />
      )}

      {/* One list per tab. Each section is an independent table, so tabs let a
          single table own the viewport and scroll its own body (fixed header +
          footer) — stacking them as cards can't keep every header/footer
          visible at once. */}
      <Tabs
        value={tab}
        onValueChange={onTabChange}
        className="flex flex-1 min-h-0 flex-col gap-4"
      >
        <TabsList className="shrink-0">
          <TabsTrigger value="users">
            {t("listCardTitle")}
            <span className="text-muted-foreground">{activeCount}</span>
          </TabsTrigger>
          {matrix && <TabsTrigger value="access">{t("tabAccess")}</TabsTrigger>}
          {pendingInvitations.length > 0 && (
            <TabsTrigger value="pending">
              {t("pendingTitle")}
              <span className="text-muted-foreground">
                {pendingInvitations.length}
              </span>
            </TabsTrigger>
          )}
          {expiredInvitations.length > 0 && (
            <TabsTrigger value="expired">
              {t("expiredTitle")}
              <span className="text-muted-foreground">
                {expiredInvitations.length}
              </span>
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="users" className="flex flex-1 min-h-0 flex-col">
          <UsersTable
            users={visibleUsers}
            now={nowDate}
            currentUserId={currentUserId}
            perms={perms}
            applyOptimistic={applyUserAction}
            toolbar={filterBar("users")}
          />
        </TabsContent>

        {matrix && (
          <TabsContent value="access" className="flex flex-1 min-h-0 flex-col">
            <AccessMatrix
              users={visibleUsers}
              matrix={matrix}
              now={nowDate}
              currentUserId={currentUserId}
              toolbar={filterBar("access")}
            />
          </TabsContent>
        )}

        {pendingInvitations.length > 0 && (
          <TabsContent value="pending" className="flex flex-1 min-h-0 flex-col">
            <InvitationsTable
              invitations={pendingInvitations}
              urlKey="inv"
              applyOptimistic={applyInvitationAction}
            />
          </TabsContent>
        )}

        {expiredInvitations.length > 0 && (
          <TabsContent value="expired" className="flex flex-1 min-h-0 flex-col">
            <InvitationsTable
              invitations={expiredInvitations}
              urlKey="invx"
              applyOptimistic={applyInvitationAction}
            />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
