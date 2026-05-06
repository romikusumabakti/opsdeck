"use client";

import { KeyRound, LogOut, Server, UserRound, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { authClient } from "@/lib/auth-client";

type UserSummary = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
};

export function UserMenu({ user }: { user: UserSummary }) {
  const t = useTranslations("userMenu");
  const router = useRouter();

  async function onSignOut() {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  const initials = (user.name || user.email)
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t("ariaLabel")}
        >
          <span className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
            {initials}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <div className="px-3 py-2 border-b mb-1">
          <div className="flex items-center gap-2">
            <UserRound className="size-4 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{user.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {user.email}
              </div>
            </div>
          </div>
        </div>
        <Link
          href="/users"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
        >
          <Users className="size-4" />
          <span>{t("users")}</span>
        </Link>
        <Link
          href="/servers"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
        >
          <Server className="size-4" />
          <span>{t("servers")}</span>
        </Link>
        <Link
          href="/account/change-password"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
        >
          <KeyRound className="size-4" />
          <span>{t("changePassword")}</span>
        </Link>
        <button
          type="button"
          onClick={onSignOut}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent text-destructive"
        >
          <LogOut className="size-4" />
          <span>{t("signOut")}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
