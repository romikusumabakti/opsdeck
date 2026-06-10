"use client";

import type * as React from "react";
import { LiveTaskPanel } from "@/components/live-task-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  // Forwarded to LiveTaskPanel — fires when the task succeeds.
  onSuccess?: React.ComponentProps<typeof LiveTaskPanel>["onSuccess"];
  // Forwarded to LiveTaskPanel — re-triggers the operation on failure.
  onRetry?: () => void;
  // Optional content rendered below the live panel (e.g. copy filename).
  footer?: React.ReactNode;
};

// Wraps LiveTaskPanel inside a Dialog. The dialog is "open" iff taskId is set;
// closing (X / ESC / overlay-click) calls onOpenChange(false) so the caller can
// clear the task and re-fetch related state. The task itself keeps running
// server-side even if dismissed early.
export function LiveTaskDialog({
  taskId,
  onOpenChange,
  title,
  description,
  onSuccess,
  onRetry,
  footer,
}: Props) {
  return (
    <Dialog open={taskId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && (
            <DialogDescription asChild>
              <div className="flex items-center gap-1 flex-wrap">
                {description}
              </div>
            </DialogDescription>
          )}
        </DialogHeader>
        {taskId && (
          <LiveTaskPanel
            key={taskId}
            taskId={taskId}
            onSuccess={onSuccess}
            onRetry={onRetry}
          />
        )}
        {footer}
      </DialogContent>
    </Dialog>
  );
}
