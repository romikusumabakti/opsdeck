"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type DialogType = "alert" | "confirm" | "prompt" | "confirmTyping";

interface DialogOptions {
  title?: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  defaultValue?: string; // For prompt only
  placeholder?: string; // For prompt only
  destructive?: boolean; // Styles confirm button as destructive
  // confirmTyping only:
  phrase?: string;
  phraseLabel?: React.ReactNode;
}

interface DialogState {
  open: boolean;
  type: DialogType;
  options: DialogOptions;
  // biome-ignore lint/suspicious/noExplicitAny: resolver type varies by dialog kind
  resolve: (value: any) => void;
}

const DialogContext = React.createContext<{
  alert: (options: DialogOptions) => Promise<void>;
  confirm: (options: DialogOptions) => Promise<boolean>;
  confirmTyping: (
    options: DialogOptions & { phrase: string }
  ) => Promise<boolean>;
  prompt: (options: DialogOptions) => Promise<string | null>;
} | null>(null);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [dialogState, setDialogState] = React.useState<DialogState>({
    open: false,
    type: "alert",
    options: {},
    resolve: () => {},
  });

  const [promptValue, setPromptValue] = React.useState("");
  const [typingValue, setTypingValue] = React.useState("");

  // Reset input values when dialog opens/closes
  React.useEffect(() => {
    if (!dialogState.open) return;
    if (dialogState.type === "prompt") {
      setPromptValue(dialogState.options.defaultValue || "");
    } else if (dialogState.type === "confirmTyping") {
      setTypingValue("");
    }
  }, [dialogState.open, dialogState.type, dialogState.options.defaultValue]);

  const closeDialog = () => {
    setDialogState((prev) => ({ ...prev, open: false }));
  };

  const alert = (options: DialogOptions) => {
    return new Promise<void>((resolve) => {
      setDialogState({
        open: true,
        type: "alert",
        options,
        resolve: () => {
          closeDialog();
          resolve();
        },
      });
    });
  };

  const confirm = (options: DialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setDialogState({
        open: true,
        type: "confirm",
        options,
        resolve: (value: boolean) => {
          closeDialog();
          resolve(value);
        },
      });
    });
  };

  const confirmTyping = (options: DialogOptions & { phrase: string }) => {
    return new Promise<boolean>((resolve) => {
      setDialogState({
        open: true,
        type: "confirmTyping",
        options: { destructive: true, ...options },
        resolve: (value: boolean) => {
          closeDialog();
          resolve(value);
        },
      });
    });
  };

  const prompt = (options: DialogOptions) => {
    return new Promise<string | null>((resolve) => {
      setDialogState({
        open: true,
        type: "prompt",
        options,
        resolve: (value: string | null) => {
          closeDialog();
          resolve(value);
        },
      });
    });
  };

  const typingMatches =
    dialogState.type === "confirmTyping" &&
    typingValue.trim() === (dialogState.options.phrase ?? "").trim() &&
    typingValue.length > 0;

  const handleConfirm = () => {
    if (dialogState.type === "prompt") {
      dialogState.resolve(promptValue);
    } else if (dialogState.type === "confirmTyping") {
      if (!typingMatches) return;
      dialogState.resolve(true);
    } else if (dialogState.type === "confirm") {
      dialogState.resolve(true);
    } else {
      dialogState.resolve(true);
    }
  };

  const handleCancel = () => {
    if (dialogState.type === "prompt") {
      dialogState.resolve(null);
    } else {
      dialogState.resolve(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (dialogState.type === "prompt") {
      e.preventDefault();
      handleConfirm();
    } else if (dialogState.type === "confirmTyping" && typingMatches) {
      e.preventDefault();
      handleConfirm();
    }
  };

  const isDestructive = dialogState.options.destructive === true;
  const confirmDisabled =
    dialogState.type === "confirmTyping" && !typingMatches;

  return (
    <DialogContext.Provider value={{ alert, confirm, confirmTyping, prompt }}>
      {children}

      <AlertDialog
        open={dialogState.open}
        onOpenChange={(open) => !open && handleCancel()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialogState.options.title ?? "Notification"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialogState.options.description}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {dialogState.type === "prompt" && (
            <div className="py-2">
              <Input
                autoFocus
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={dialogState.options.placeholder}
              />
            </div>
          )}

          {dialogState.type === "confirmTyping" && (
            <div className="flex flex-col gap-2">
              {dialogState.options.phraseLabel && (
                <Label
                  htmlFor="dialog-confirm-typing-input"
                  className="text-sm"
                >
                  {dialogState.options.phraseLabel}
                </Label>
              )}
              <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm select-all">
                {dialogState.options.phrase}
              </div>
              <Input
                id="dialog-confirm-typing-input"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={typingValue}
                onChange={(e) => setTypingValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={dialogState.options.placeholder}
                aria-invalid={typingValue.length > 0 && !typingMatches}
              />
            </div>
          )}

          <AlertDialogFooter>
            {dialogState.type !== "alert" && (
              <AlertDialogCancel onClick={handleCancel}>
                {dialogState.options.cancelText ?? "Cancel"}
              </AlertDialogCancel>
            )}
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={confirmDisabled}
              className={cn(
                isDestructive && buttonVariants({ variant: "destructive" })
              )}
            >
              {dialogState.options.confirmText ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContext.Provider>
  );
}

export const useDialog = () => {
  const context = React.useContext(DialogContext);
  if (!context) {
    throw new Error("useDialog must be used within a DialogProvider");
  }
  return context;
};
