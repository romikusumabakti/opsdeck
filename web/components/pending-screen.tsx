// What a route shows while its loader runs past the router's pending delay.
// No text: it can render before the locale's messages have loaded.
export function PendingScreen() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-dvh flex-1 items-center justify-center"
    >
      <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
    </div>
  );
}
