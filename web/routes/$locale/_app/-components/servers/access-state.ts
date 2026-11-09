import type { ServerRow } from "@/web/api/servers";

/**
 * How the Panel signs in to a server, as the list and the server page show
 * it:
 * - hostKeyChanged: the server offered another host key, nothing connects;
 * - needsSetup: a password server with no password stored (a password-once
 *   install that failed), so it has no working credential;
 * - keyNotVerified: a key installed by hand whose login never succeeded;
 * - key / password.
 */
export type AccessState =
  | "hostKeyChanged"
  | "needsSetup"
  | "keyNotVerified"
  | "key"
  | "password";

export function accessState(
  server: Pick<
    ServerRow,
    "auth" | "hasPassword" | "hostKeyMismatch" | "keyError"
  >
): AccessState {
  if (server.hostKeyMismatch) return "hostKeyChanged";
  if (server.auth === "password") {
    return server.hasPassword ? "password" : "needsSetup";
  }
  return server.keyError === "keyNotVerified" ? "keyNotVerified" : "key";
}
