"use client";

import { useTranslations } from "next-intl";
import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Link, usePathname } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";

const SEGMENT_KEYS: Record<string, string> = {
  projects: "projects",
  servers: "servers",
  users: "users",
  account: "account",
  "change-password": "changePassword",
  "backup-database": "backupDatabase",
  "restore-database": "restoreDatabase",
  history: "history",
  settings: "settings",
  new: "new",
};

const HREF_OVERRIDES: Record<string, string> = {
  "/projects": "/",
};

const isUuid = (s: string) => /^[0-9a-f-]{20,}$/i.test(s);

type Segment = { href?: string; label: string };

export function Breadcrumbs({ projects }: { projects: Project[] }) {
  const pathname = usePathname();
  const t = useTranslations("breadcrumbs");

  if (pathname === "/") return null;

  const parts = pathname.split("/").filter(Boolean);
  const segments: Segment[] = [];

  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    acc += `/${p}`;

    let label: string;
    if (isUuid(p)) {
      if (parts[i - 1] === "projects") {
        const proj = projects.find((x) => x.id === p);
        label = proj?.name ?? t("loading");
      } else {
        label = t("edit");
      }
    } else {
      const key = SEGMENT_KEYS[p];
      label = key ? t(key) : p;
    }

    const isLast = i === parts.length - 1;
    const href = HREF_OVERRIDES[acc] ?? acc;
    segments.push({ href: isLast ? undefined : href, label });
  }

  if (segments.length === 0) return null;

  return (
    <div className="border-b bg-background/50 px-4 py-2.5 sm:px-6">
      <Breadcrumb>
        <BreadcrumbList>
          {segments.map((s, i) => (
            <Fragment key={`${i}-${s.label}`}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {s.href ? (
                  <BreadcrumbLink asChild>
                    <Link href={s.href}>{s.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{s.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
