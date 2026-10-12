import type { UserListRow } from "@/actions/users";
import type { OrgRole } from "@/lib/permissions";

export type UserRow = UserListRow;

export type InvitationRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
};

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
  | { type: "renew"; id: string; expiresAt: Date };

export type UserFilterState = { showBanned: boolean; inactiveOnly: boolean };
