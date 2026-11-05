import { createContext, useContext } from "react";
import {
  canEnvironment,
  type ProjectPermissions,
  type ProjectRole,
} from "@/lib/permissions";

// The caller's effective role on the project in scope, and whether they own
// the environment in scope, computed once in the environment layout. Buttons
// read it to disable what the caller can't do; the server actions enforce the
// same rules (lib/permissions#canEnvironment) regardless.
type ProjectRoleValue = { role: ProjectRole | null; isOwner: boolean };

const ProjectRoleContext = createContext<ProjectRoleValue>({
  role: null,
  isOwner: false,
});

export function ProjectRoleProvider({
  role,
  isOwner = false,
  children,
}: {
  role: ProjectRole;
  isOwner?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ProjectRoleContext.Provider value={{ role, isOwner }}>
      {children}
    </ProjectRoleContext.Provider>
  );
}

export function useProjectRole(): ProjectRole | null {
  return useContext(ProjectRoleContext).role;
}

export function useProjectCan(perms: ProjectPermissions): boolean {
  const { role, isOwner } = useContext(ProjectRoleContext);
  return canEnvironment(role, isOwner, perms);
}
