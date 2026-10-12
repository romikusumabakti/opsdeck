"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { UserStatus } from "@/lib/access";
import { isOrgRole } from "@/lib/permissions";

export function RoleBadge({ role }: { role: string }) {
  const t = useTranslations("users");
  // Unknown/legacy role strings render verbatim rather than blowing up on a
  // missing translation key — an unknown role is treated as `member` for access.
  const label = isOrgRole(role) ? t(`role.${role}`) : role;
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
