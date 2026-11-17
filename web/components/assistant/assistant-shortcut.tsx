import { useEffect } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";

/** The question box's id, so the shortcut can focus it in place. */
export const ASSISTANT_COMPOSER_ID = "assistant-composer";

/** The shortcut as the palette shows Ctrl K: `⌘J` on a Mac, else `Ctrl J`. */
export function assistantShortcutLabel(modKey: string): string {
  return modKey === "⌘" ? "⌘J" : `${modKey} J`;
}

/** Ctrl+J (Cmd+J on a Mac), no other modifier. */
function isAssistantShortcut(e: KeyboardEvent): boolean {
  return (
    e.key.toLowerCase() === "j" &&
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey
  );
}

/** Inside a contenteditable (the rich-text editor), which owns its keys. */
function inRichText(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

/**
 * Opens the assistant: focuses its question box when already there, else
 * navigates to `/assistant`, whose box takes focus as it mounts.
 */
export function openAssistant(
  router: { push: (href: string) => void },
  pathname: string
) {
  if (pathname === "/assistant") {
    document.getElementById(ASSISTANT_COMPOSER_ID)?.focus();
  } else {
    router.push("/assistant");
  }
}

/**
 * Ctrl/Cmd+J anywhere in the app opens the assistant, like Ctrl/Cmd+K opens
 * the command palette. It yields to the rich-text editor and to any handler
 * that already claimed the key (`preventDefault`). Mounted by the app shell
 * only while the assistant is on and the user sees a project.
 */
export function AssistantShortcut() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!isAssistantShortcut(e) || e.defaultPrevented) return;
      if (inRichText(e.target)) return;
      e.preventDefault();
      openAssistant(router, pathname);
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [router, pathname]);

  return null;
}
