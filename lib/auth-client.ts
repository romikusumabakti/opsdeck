"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [adminClient(), passkeyClient()],
});

export const {
  useSession,
  signIn,
  signOut,
  changePassword,
  requestPasswordReset,
  resetPassword,
  // Live list of the current user's passkeys. The plugin re-fetches it after
  // add/delete, so the account page does not have to refresh it by hand.
  useListPasskeys,
} = authClient;

/**
 * Whether this browser can do WebAuthn at all. Read it in an effect, never
 * during render — the server has no `window`, and a passkey button rendered on
 * the server and then removed on hydration is a mismatch.
 */
export function isPasskeySupported() {
  return typeof window !== "undefined" && Boolean(window.PublicKeyCredential);
}

/**
 * Whether the browser can offer passkeys inside the browser's own autofill
 * dropdown (WebAuthn "conditional mediation"). Chrome, Safari and Firefox all
 * support it; anything else falls back to the explicit button.
 */
export async function isPasskeyAutofillSupported() {
  if (!isPasskeySupported()) return false;
  const available = window.PublicKeyCredential.isConditionalMediationAvailable;
  if (typeof available !== "function") return false;
  try {
    return await available.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}
