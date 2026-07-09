"use client";

import type * as React from "react";
import { LiveRunPanel } from "@/components/live-run-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  runId: string | null;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  // Forwarded to LiveRunPanel — fires when the run succeeds.
  onSuccess?: React.ComponentProps<typeof LiveRunPanel>["onSuccess"];
  // Forwarded to LiveRunPanel — re-triggers the operation on failure.
  onRetry?: () => void;
  // Optional content rendered below the live panel (e.g. copy filename).
  footer?: React.ReactNode;
};

// Wraps LiveRunPanel inside a Dialog. The dialog is "open" iff runId is set;
// closing (X / ESC / overlay-click) calls onOpenChange(false) so the caller can
// clear the run and re-fetch related state. The run itself keeps running
// server-side even if dismissed early.
export function LiveRunDialog({
  runId,
  onOpenChange,
  title,
  description,
  onSuccess,
  onRetry,
  footer,
}: Props) {
  return (
    <Dialog open={runId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && (
            <DialogDescription
              render={<div className="flex items-center gap-1 flex-wrap" />}
            >
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {runId && (
          <LiveRunPanel
            key={runId}
            runId={runId}
            onSuccess={onSuccess}
            onRetry={onRetry}
          />
        )}
        {footer}
      </DialogContent>
    </Dialog>
  );
}
