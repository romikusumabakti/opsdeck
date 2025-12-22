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
import { Input } from "@/components/ui/input";

// Define the types of dialogs available
type DialogType = "alert" | "confirm" | "prompt";

// Define the options passed to the hook
interface DialogOptions {
  title?: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  defaultValue?: string; // For prompt only
  placeholder?: string; // For prompt only
}

interface DialogState {
  open: boolean;
  type: DialogType;
  options: DialogOptions;
  resolve: (value: any) => void;
}

const DialogContext = React.createContext<{
  alert: (options: DialogOptions) => Promise<void>;
  confirm: (options: DialogOptions) => Promise<boolean>;
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

  // Reset prompt value when dialog opens/closes
  React.useEffect(() => {
    if (dialogState.open && dialogState.type === "prompt") {
      setPromptValue(dialogState.options.defaultValue || "");
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

  // Helper to handle the "Confirm/OK" click
  const handleConfirm = () => {
    if (dialogState.type === "prompt") {
      dialogState.resolve(promptValue);
    } else if (dialogState.type === "confirm") {
      dialogState.resolve(true);
    } else {
      dialogState.resolve(true); // Alert just resolves
    }
  };

  // Helper to handle the "Cancel" click
  const handleCancel = () => {
    if (dialogState.type === "prompt") {
      dialogState.resolve(null);
    } else {
      dialogState.resolve(false);
    }
  };

  // Handle enter key in prompt
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && dialogState.type === "prompt") {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <DialogContext.Provider value={{ alert, confirm, prompt }}>
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

          <AlertDialogFooter>
            {dialogState.type !== "alert" && (
              <AlertDialogCancel onClick={handleCancel}>
                {dialogState.options.cancelText ?? "Cancel"}
              </AlertDialogCancel>
            )}
            <AlertDialogAction onClick={handleConfirm}>
              {dialogState.options.confirmText ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContext.Provider>
  );
}

// Custom hook to consume the context
export const useDialog = () => {
  const context = React.useContext(DialogContext);
  if (!context) {
    throw new Error("useDialog must be used within a DialogProvider");
  }
  return context;
};
