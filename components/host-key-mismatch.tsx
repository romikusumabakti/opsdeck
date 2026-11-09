import { Link } from "@/i18n/navigation";

// How a connection refused on a changed host key reaches the browser, and the
// link to the server page where an admin reviews the key. The terminal
// sidecar sends the code as its error frame; the file explorer's listing
// answers with it as `code`.

export const HOST_KEY_MISMATCH = "hostKeyMismatch";

/** Whether a terminal error frame's message is the host key refusal. */
export function isHostKeyMismatchFrame(message: string): boolean {
  return message === HOST_KEY_MISMATCH;
}

/** Whether a failed explorer listing was refused on the host key. */
export function isHostKeyMismatchFailure(result: {
  success: boolean;
}): boolean {
  return (
    !result.success &&
    "code" in result &&
    (result as { code?: unknown }).code === HOST_KEY_MISMATCH
  );
}

export function serverPageHref(serverId: string): string {
  return `/servers/${serverId}`;
}

export function HostKeyReviewLink({
  serverId,
  children,
}: {
  serverId: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={serverPageHref(serverId)} className="underline">
      {children}
    </Link>
  );
}
