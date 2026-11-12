import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import type { UserStatus } from "@/lib/access";
import { normalizeOrgRole } from "@/lib/permissions";

export function RoleBadge({ role }: { role: string }) {
  const t = useTranslations("users");
  // An unknown or legacy role string (e.g. `member`) is treated as `qa` for
  // access, so it is shown as `qa` too.
  const label = t(`role.${normalizeOrgRole(role)}`);
  return (
    <Badge
      variant={role === "admin" ? "default" : "secondary"}
      className="text-xs"
    >
      {label}
    </Badge>
  );
}

// Banned or Inactive; active users get no badge.
export function StatusBadge({ status }: { status: UserStatus }) {
  const t = useTranslations("access");
  if (status === "banned") {
    return (
      <Badge variant="destructive" className="text-xs">
        {t("banned")}
      </Badge>
    );
  }
  if (status === "inactive") {
    return (
      <Badge variant="outline" className="text-xs">
        {t("inactive")}
      </Badge>
    );
  }
  return null;
}
