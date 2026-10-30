// Plain URL builders, shared by server and client code. Deliberately free of
// "use client" and of any server import so both sides can import them.

export function teamsChatUrl(email: string): string {
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`;
}
