"use client";

import * as React from "react";
import type { RunningTask } from "@/actions/tasks";

const STORAGE_KEY = "dss-panel:task-notifications";
const CHANGE_EVENT = "dss:notifications-changed";

export type NotificationLabels = {
  titleSuccess: string;
  titleFailed: string;
};

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationsPreference(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setNotificationsPreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export async function requestNotificationsPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return await Notification.requestPermission();
}

function isActive(): boolean {
  return (
    notificationsSupported() &&
    Notification.permission === "granted" &&
    getNotificationsPreference()
  );
}

// Subscribes to the localStorage-backed preference + the browser permission so
// UI controls can reflect the current state without polling.
export function useNotificationsState() {
  const [permission, setPermission] = React.useState<NotificationPermission>(
    () => (notificationsSupported() ? Notification.permission : "denied")
  );
  const [enabled, setEnabled] = React.useState(() =>
    getNotificationsPreference()
  );

  React.useEffect(() => {
    const onChange = () => {
      setEnabled(getNotificationsPreference());
      if (notificationsSupported()) setPermission(Notification.permission);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("focus", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("focus", onChange);
    };
  }, []);

  return {
    supported: notificationsSupported(),
    permission,
    enabled,
    setEnabled: setNotificationsPreference,
    requestPermission: async () => {
      const result = await requestNotificationsPermission();
      setPermission(result);
      return result;
    },
  };
}

// Fetches the terminal snapshot for a task via the existing SSE endpoint and
// fires a system notification with its status. We reuse SSE rather than adding
// a one-shot REST endpoint to keep auth + serialization paths consistent.
function notifyForTask(id: string, labels: NotificationLabels) {
  const es = new EventSource(`/api/tasks/${id}/stream`);
  let fired = false;
  const cleanup = () => {
    es.close();
    clearTimeout(timeoutId);
  };
  es.addEventListener("snapshot", (ev) => {
    try {
      const snap = JSON.parse((ev as MessageEvent).data) as {
        description: string;
        status: "started" | "success" | "failed";
      };
      if (snap.status === "started" || fired) return;
      fired = true;
      const title =
        snap.status === "success" ? labels.titleSuccess : labels.titleFailed;
      const n = new Notification(title, {
        body: snap.description,
        tag: id,
        icon: "/favicon.ico",
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      cleanup();
    } catch {
      cleanup();
    }
  });
  es.onerror = () => cleanup();
  // Guard against stuck connections: give the server up to 5s to replay the
  // final frame, then give up — the user can still see the result in-app.
  const timeoutId = setTimeout(cleanup, 5000);
}

// Diff the running-task list across renders. When a task ID disappears,
// resolve its final status from the per-task SSE stream and notify if the
// document is hidden + the user has opted in.
export function useTaskCompletionNotifications(
  runningTasks: RunningTask[],
  labels: NotificationLabels
) {
  const seenIdsRef = React.useRef<Set<string>>(new Set());
  const firstSnapshotRef = React.useRef(true);
  const labelsRef = React.useRef(labels);
  React.useEffect(() => {
    labelsRef.current = labels;
  }, [labels]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const currentIds = new Set(runningTasks.map((task) => task.id));

    // Suppress notifications for tasks that were already running when the
    // panel loaded — only fire for transitions observed during this session.
    if (firstSnapshotRef.current) {
      seenIdsRef.current = currentIds;
      firstSnapshotRef.current = false;
      return;
    }

    const completed: string[] = [];
    for (const id of seenIdsRef.current) {
      if (!currentIds.has(id)) completed.push(id);
    }
    seenIdsRef.current = currentIds;

    if (completed.length === 0) return;
    if (!isActive()) return;
    if (document.visibilityState === "visible") return;

    for (const id of completed) {
      notifyForTask(id, labelsRef.current);
    }
  }, [runningTasks]);
}
