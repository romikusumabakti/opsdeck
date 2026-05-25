"use client";

import { useEffect, useState } from "react";

const TIME_ZONE = "Asia/Jakarta";
const UTC_OFFSET = "+07:00";

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: TIME_ZONE,
});

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TIME_ZONE,
});

export function ServerTime() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    return (
      <span className="font-mono text-xs tabular-nums text-muted-foreground/60 bg-muted/40 border border-border/50 rounded px-2 py-0.5">
        --:--:-- <span className="text-muted-foreground/40">{UTC_OFFSET}</span>
      </span>
    );
  }

  return (
    <span
      className="font-mono text-xs tabular-nums text-muted-foreground bg-muted/40 border border-border/50 rounded px-2 py-0.5"
      title={`${dateFormatter.format(now)}T${timeFormatter.format(now)}${UTC_OFFSET} (${TIME_ZONE})`}
    >
      {timeFormatter.format(now)}{" "}
      <span className="text-muted-foreground/50">{UTC_OFFSET}</span>
    </span>
  );
}
