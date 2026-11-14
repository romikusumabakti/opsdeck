import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { Link, useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";
import {
  canOrgAccess,
  type OrgPermissions,
  requiresStrongSignIn,
} from "@/lib/permissions";
import { isStrongSignIn } from "@/lib/sign-in-method";
import { resetSession, useMe } from "@/web/api/session";

// Representative strong-only org actions. A role that can do any of them
// (admin, infra, engineer) loses something real on a weak session; for the
// rest the banner would be noise.
const STRONG_ONLY_SAMPLES: OrgPermissions[] = [
  { server: ["terminal"] },
  { server: ["files"] },
  { user: ["update"] },
  { instance: ["manage"] },
];

const dismissKey = (sessionId: string) =>
  `strong-sign-in-dismissed:${sessionId}`;

/**
 * Tells a user on a password-only session what that session can't do, and how
 * to fix it. Dismissal lasts for this browser session and is keyed by the
 * sign-in session, so a new sign-in shows it again.
 */
export function StrongSignInBanner() {
  const t = useTranslations("strongSignIn");
  const router = useRouter();
  const me = useMe();
  const sessionId = me?.session.id;
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (sessionId) {
      setDismissed(sessionStorage.getItem(dismissKey(sessionId)) === "1");
    }
  }, [sessionId]);

  if (!me || dismissed) return null;
  if (isStrongSignIn(me.session.signInMethod)) return null;
  const affected = STRONG_ONLY_SAMPLES.some(
    (perms) => requiresStrongSignIn(perms) && canOrgAccess(me.orgRole, perms)
  );
  if (!affected) return null;

  const dismiss = () => {
    sessionStorage.setItem(dismissKey(me.session.id), "1");
    setDismissed(true);
  };
  async function onSignOut() {
    await authClient.signOut();
    await resetSession();
    router.push("/sign-in");
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="flex-1">{t("banner")}</span>
      <Button
        size="sm"
        nativeButton={false}
        render={<Link href="/account?tab=security" />}
      >
        {t("setUp")}
      </Button>
      <Button size="sm" variant="outline" onClick={onSignOut}>
        {t("signOut")}
      </Button>
      <TooltipHint label={t("dismiss")}>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("dismiss")}
          onClick={dismiss}
        >
          <X className="size-4" />
        </Button>
      </TooltipHint>
    </div>
  );
}
