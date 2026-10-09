"use client";

import { useState } from "react";
import { avatarSrc } from "@/lib/avatar-url";
import type { UserRef } from "@/lib/types";
import { avatarColorIndex, getInitials } from "@/lib/user-display";
import { cn } from "@/lib/utils";

const SIZES = { xs: 20, sm: 24, md: 32, lg: 64, xl: 128 } as const;
export type AvatarSize = keyof typeof SIZES;

const TEXT = { xs: "text-[9px]", sm: "text-[10px]", md: "text-xs", lg: "text-xl", xl: "text-4xl" } as const;

// 100/900 pairs keep initials at AA contrast in both themes.
const COLORS = [
  "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  "bg-rose-100 text-rose-900 dark:bg-rose-900 dark:text-rose-100",
  "bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
  "bg-teal-100 text-teal-900 dark:bg-teal-900 dark:text-teal-100",
  "bg-orange-100 text-orange-900 dark:bg-orange-900 dark:text-orange-100",
  "bg-indigo-100 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100",
] as const;

export function UserAvatar({
  user,
  size = "sm",
  className,
  label,
}: {
  user: Pick<UserRef, "id" | "name" | "image"> & { email?: string };
  size?: AvatarSize;
  className?: string;
  /** Accessible name when the avatar stands alone (no adjacent name). */
  label?: string;
}) {
  const px = SIZES[size];
  const [failed, setFailed] = useState(false);
  const box = cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full select-none", className);
  const style = { width: px, height: px };

  if (user.image && !failed) {
    return (
      // biome-ignore lint/performance/noImgElement: imgproxy already resizes and optimises the avatar.
      <img
        src={avatarSrc(user.image, px)}
        srcSet={`${avatarSrc(user.image, px)} 1x, ${avatarSrc(user.image, px * 2)} 2x`}
        alt={label ?? ""}
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(box, "object-cover bg-muted")}
        style={style}
      />
    );
  }
  const initials = cn(box, "font-semibold", TEXT[size], COLORS[avatarColorIndex(user.id)]);
  if (label) {
    return (
      <span role="img" aria-label={label} className={initials} style={style}>
        {getInitials(user.name, user.email)}
      </span>
    );
  }
  return (
    <span aria-hidden className={initials} style={style}>
      {getInitials(user.name, user.email)}
    </span>
  );
}
