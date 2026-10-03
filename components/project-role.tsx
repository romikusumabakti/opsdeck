"use client";

import { createContext, useContext } from "react";
import {
  canProject,
  type ProjectPermissions,
  type ProjectRole,
} from "@/lib/permissions";

// The caller's effective role on the project in scope, computed once in the
// environment layout. Buttons read it to disable what the role can't do; the
// server actions enforce the same statements regardless.
const ProjectRoleContext = createContext<ProjectRole | null>(null);

export function ProjectRoleProvider({
  role,
  children,
}: {
  role: ProjectRole;
  children: React.ReactNode;
}) {
  return (
    <ProjectRoleContext.Provider value={role}>
      {children}
    </ProjectRoleContext.Provider>
  );
}

export function useProjectRole(): ProjectRole | null {
  return useContext(ProjectRoleContext);
}

export function useProjectCan(perms: ProjectPermissions): boolean {
  return canProject(useContext(ProjectRoleContext), perms);
}
