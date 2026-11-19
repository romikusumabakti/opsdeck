import * as React from "react";
import {
  IssueCreateDialog,
  type IssueDefaults,
} from "@/components/issue-create-dialog";
import type { IssueProject } from "@/web/api/home";

export type IssuePrefill = {
  projectId?: string;
  environmentId?: string | null;
} & IssueDefaults;

type DialogState = {
  open: boolean;
  projectId: string;
  environmentId: string | null;
  defaults: IssueDefaults;
};

type IssueDialogApi = {
  open: (prefill?: IssuePrefill) => void;
  canCreateIn: (projectId: string) => boolean;
  canCreate: boolean;
};

const IssueDialogContext = React.createContext<IssueDialogApi | null>(null);

export function useIssueDialog(): IssueDialogApi {
  const api = React.useContext(IssueDialogContext);
  if (!api) throw new Error("useIssueDialog outside HomeIssueDialogProvider");
  return api;
}

// One create-issue dialog for the whole page: the header's New issue and each
// failure's Issue button open it with different prefills. The project is
// picked inside the dialog (its chip); the dialog loads that project's pickers.
export function HomeIssueDialogProvider({
  projects,
  defaultTarget,
  children,
}: {
  projects: IssueProject[];
  defaultTarget: { projectId: string; environmentId: string } | null;
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState<DialogState | null>(null);

  const writable = React.useMemo(
    () => new Set(projects.map((p) => p.id)),
    [projects]
  );

  const open = React.useCallback(
    (prefill: IssuePrefill = {}) => {
      const requested =
        prefill.projectId && writable.has(prefill.projectId)
          ? prefill.projectId
          : null;
      const pid = requested ?? defaultTarget?.projectId ?? projects[0]?.id;
      if (!pid) return;
      const environmentId = requested
        ? (prefill.environmentId ?? null)
        : pid === defaultTarget?.projectId
          ? defaultTarget.environmentId
          : null;
      setState({
        open: true,
        projectId: pid,
        environmentId,
        defaults: {
          title: prefill.title,
          description: prefill.description,
          type: prefill.type,
        },
      });
    },
    [writable, defaultTarget, projects]
  );

  const api = React.useMemo<IssueDialogApi>(
    () => ({
      open,
      canCreateIn: (id) => writable.has(id),
      canCreate: projects.length > 0,
    }),
    [open, writable, projects.length]
  );

  return (
    <IssueDialogContext.Provider value={api}>
      {children}
      {state ? (
        <IssueCreateDialog
          open={state.open}
          onOpenChange={(isOpen) =>
            setState((s) => (s ? { ...s, open: isOpen } : s))
          }
          projectId={state.projectId}
          defaultEnvironmentId={state.environmentId ?? ""}
          defaults={state.defaults}
          // The pickers follow the project; what no longer fits it is
          // dropped by the dialog, the rest of the properties stay.
          projectChoice={{
            projects,
            onChange: (id) =>
              setState((s) => (s ? { ...s, projectId: id } : s)),
          }}
        />
      ) : null}
    </IssueDialogContext.Provider>
  );
}
