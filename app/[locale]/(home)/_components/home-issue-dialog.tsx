"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { getIssueFormOptions, type IssueFormOptions } from "@/actions/issues";
import {
  IssueCreateDialog,
  type IssueDefaults,
} from "@/components/issue-create-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import type { IssueProject } from "@/lib/home/queries";

export type IssuePrefill = {
  projectId?: string;
  environmentId?: string | null;
} & IssueDefaults;

type DialogState = {
  open: boolean;
  projectId: string;
  environmentId: string | null;
  defaults: IssueDefaults;
  // Bumped by every open(), so reopening retries a failed options load.
  nonce: number;
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
// picked inside the dialog; its pickers load on demand.
export function HomeIssueDialogProvider({
  projects,
  defaultTarget,
  children,
}: {
  projects: IssueProject[];
  defaultTarget: { projectId: string; environmentId: string } | null;
  children: React.ReactNode;
}) {
  const t = useTranslations("homePage");
  const router = useRouter();
  const [state, setState] = React.useState<DialogState | null>(null);
  // Loaded pickers per project; a failed load leaves no entry.
  const [options, setOptions] = React.useState<
    Record<string, IssueFormOptions>
  >({});
  const loaded = React.useRef(new Set<string>());

  const writable = React.useMemo(
    () => new Set(projects.map((p) => p.id)),
    [projects]
  );
  const projectId = state?.projectId ?? null;
  const nonce = state?.nonce ?? 0;

  // Runs on each open and project change; fetches unless already loaded.
  React.useEffect(() => {
    if (!projectId || nonce === 0 || loaded.current.has(projectId)) return;
    let cancelled = false;
    getIssueFormOptions(projectId).then(
      (data) => {
        loaded.current.add(projectId);
        setOptions((o) => ({ ...o, [projectId]: data }));
      },
      () => {
        if (!cancelled) toast.error(t("issueDialog.loadFailed"));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce, t]);

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
      setState((s) => ({
        nonce: (s?.nonce ?? 0) + 1,
        open: true,
        projectId: pid,
        environmentId,
        defaults: {
          title: prefill.title,
          description: prefill.description,
          type: prefill.type,
        },
      }));
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

  const current = projectId ? (options[projectId] ?? null) : null;

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
          environments={current?.environments ?? []}
          users={current?.users ?? []}
          milestones={current?.milestones ?? []}
          defaultEnvironmentId={state.environmentId ?? ""}
          defaults={state.defaults}
          loading={current === null}
          projectPicker={
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {t("issueDialog.project")}
              </span>
              <Select
                value={state.projectId}
                onValueChange={(v) =>
                  v && setState((s) => (s ? { ...s, projectId: v } : s))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
          onCreated={() => {
            setState((s) => (s ? { ...s, open: false } : s));
            router.refresh();
          }}
        />
      ) : null}
    </IssueDialogContext.Provider>
  );
}
