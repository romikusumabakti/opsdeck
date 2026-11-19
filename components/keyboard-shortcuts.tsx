import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useModKey } from "@/hooks/use-is-mac";

type Shortcut = { keys: string[]; label: string };

function Kbd({ value }: { value: string }) {
  return (
    <kbd className="pointer-events-none inline-flex h-6 min-w-6 select-none items-center justify-center gap-1 rounded border bg-muted px-1.5 font-mono text-sm font-medium text-muted-foreground">
      {value}
    </kbd>
  );
}

export function KeyboardShortcuts({
  assistant = false,
}: {
  /** The Ctrl/Cmd+J assistant shortcut is active. */
  assistant?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const t = useTranslations("shortcuts");
  const modKey = useModKey();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;
      if (isEditable) return;

      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups: { title: string; shortcuts: Shortcut[] }[] = [
    {
      title: t("groupGeneral"),
      shortcuts: [
        { keys: [modKey, "K"], label: t("openCommandPalette") },
        ...(assistant
          ? [{ keys: [modKey, "J"], label: t("openAssistant") }]
          : []),
        { keys: ["?"], label: t("openShortcuts") },
        { keys: ["Esc"], label: t("closeDialog") },
      ],
    },
    {
      // Markdown editors (Knowledge documents, issue descriptions): formatting
      // lives in contextual menus, so their keyboard route is listed here.
      title: t("groupEditor"),
      shortcuts: [
        { keys: ["Alt", "F10"], label: t("editorFocusMenu") },
        // Alt+F10 is taken by GNOME's window manager; this one always works.
        { keys: [modKey, "Shift", "."], label: t("editorFocusMenu") },
        { keys: ["Esc"], label: t("editorLeaveMenu") },
        { keys: [modKey, "Z"], label: t("editorUndo") },
        { keys: [modKey, "Shift", "Z"], label: t("editorRedo") },
      ],
    },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {g.title}
              </h3>
              <ul className="flex flex-col gap-2">
                {g.shortcuts.map((s) => (
                  <li
                    key={`${s.label}-${s.keys.join("+")}`}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="text-sm">{s.label}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, i) => (
                        <Kbd key={`${s.label}-${i}`} value={k} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
