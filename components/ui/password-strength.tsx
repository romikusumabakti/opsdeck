"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Heuristic 0–4 strength score. Not a security guarantee — purely a UX hint to
 * nudge users toward longer, more varied passwords. The server still enforces
 * the real minimum-length rule.
 */
function scorePassword(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.min(score, 4);
}

const LEVELS = [
  { key: "weak", bar: "bg-destructive", text: "text-destructive" },
  { key: "fair", bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-500" },
  { key: "good", bar: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-500" },
  { key: "strong", bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-500" },
] as const;

export function PasswordStrength({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const t = useTranslations("passwordStrength");
  if (!value) return null;

  const score = scorePassword(value);
  // Map 0–4 score to a 1–4 level index so any non-empty value shows progress.
  const levelIndex = Math.max(0, Math.min(score, 4) - 1);
  const level = LEVELS[levelIndex];
  const filled = levelIndex + 1;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex gap-1" aria-hidden="true">
        {LEVELS.map((l, i) => (
          <span
            key={l.key}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              i < filled ? level.bar : "bg-muted"
            )}
          />
        ))}
      </div>
      <p className={cn("text-xs", level.text)}>
        {t("label")}: {t(level.key)}
      </p>
    </div>
  );
}
