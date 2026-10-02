// Mailpit's /api/events WebSocket sends `{ Type, Data }` frames. Only the ones
// that change what the inbox list shows are relayed; `stats` (counter ticks)
// and `error` frames are dropped.
const LIST_EVENTS = ["new", "update", "delete", "truncate", "prune"] as const;
export type MailEventType = (typeof LIST_EVENTS)[number];

export function mailEventType(raw: unknown): MailEventType | null {
  if (typeof raw !== "string") return null;
  try {
    const type = (JSON.parse(raw) as { Type?: unknown }).Type;
    return LIST_EVENTS.includes(type as MailEventType)
      ? (type as MailEventType)
      : null;
  } catch {
    return null;
  }
}
