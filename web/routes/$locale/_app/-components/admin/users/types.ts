import type { OrgRole } from "@/lib/permissions";
import type { PendingInvitation, UserListRow } from "@/web/api/users";

export type UserRow = UserListRow;

// API dates are ISO strings.
export type InvitationRow = Pick<
  PendingInvitation,
  "id" | "email" | "name" | "role" | "expiresAt" | "createdAt"
>;

// Optimistic edits to the users list, applied by the shell's useOptimistic so
// every tab (Users and Project access) reflects them at once.
export type UserAction =
  | { type: "remove"; ids: string[] }
  | { type: "updateRole"; id: string; role: OrgRole }
  | { type: "updateName"; id: string; name: string }
  | { type: "removeImage"; id: string }
  | { type: "offboard"; id: string };

export type InvitationAction =
  | { type: "add"; invitation: InvitationRow }
  | { type: "remove"; ids: string[] }
  | { type: "renew"; id: string; expiresAt: string };

export type UserFilterState = { showBanned: boolean; inactiveOnly: boolean };
