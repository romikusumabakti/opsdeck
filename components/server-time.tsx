"use client";

import { useEffect, useState } from "react";

const TIME_ZONE = "Asia/Jakarta";

const timeFormatter = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: TIME_ZONE,
});

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
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
      <span className="text-sm tabular-nums text-muted-foreground">
        --:--:--
      </span>
    );
  }

  return (
    <span
      className="text-sm tabular-nums text-muted-foreground"
      title={`${dateFormatter.format(now)} (${TIME_ZONE})`}
    >
      {timeFormatter.format(now)} WIB
    </span>
  );
}
