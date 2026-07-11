"use client";

import { format, type Locale } from "date-fns";
import * as React from "react";

/**
 * Renders a ticking clock label. The per-second state lives here so the tick
 * only re-renders this component — not the parent, which would otherwise close
 * an open date-picker dropdown every second.
 *
 * Anchors on the server's mocked `now` rather than `new Date()`; the project
 * clock may be time-traveled. Pauses when `frozen`.
 */
export function LiveClock({
  now,
  frozen = false,
  dateFnsLocale,
}: {
  now: string;
  frozen?: boolean;
  dateFnsLocale: Locale | undefined;
}) {
  const [displayed, setDisplayed] = React.useState<Date>(() => new Date(now));

  React.useEffect(() => {
    const serverMs = new Date(now).getTime();
    const localMs = Date.now();
    setDisplayed(new Date(serverMs));
    if (frozen) return;
    const id = setInterval(() => {
      setDisplayed(new Date(serverMs + (Date.now() - localMs)));
    }, 1000);
    return () => clearInterval(id);
  }, [now, frozen]);

  return <>{format(displayed, "PPP HH:mm:ss", { locale: dateFnsLocale })}</>;
}
