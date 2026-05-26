"use client";

import { useEffect, useState } from "react";

function getUtcOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  return tz.replace("GMT", "") || "+00:00";
}

export function ServerTime({ timeZone }: { timeZone: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });

  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });

  if (!now) {
    return (
      <span className="font-mono text-xs tabular-nums text-muted-foreground/60 bg-muted/40 border border-border/50 rounded px-2 py-0.5">
        --:--:--
      </span>
    );
  }

  const offset = getUtcOffset(now, timeZone);

  return (
    <span
      className="font-mono text-xs tabular-nums text-muted-foreground bg-muted/40 border border-border/50 rounded px-2 py-0.5"
      title={`${dateFormatter.format(now)}T${timeFormatter.format(now)}${offset} (${timeZone})`}
    >
      {timeFormatter.format(now)}{" "}
      <span className="text-muted-foreground/50">{offset}</span>
    </span>
  );
}
