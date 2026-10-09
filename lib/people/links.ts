// Plain URL builders, shared by server and client components. Deliberately
// free of "use client" and "server-only" so both sides can import them.

export function teamsChatUrl(email: string): string {
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`;
}
