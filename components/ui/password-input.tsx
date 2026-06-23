"use client";

import { ArrowBigUp, Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function PasswordInput({
  className,
  disabled,
  onKeyUp,
  onKeyDown,
  onBlur,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  const t = useTranslations("common");
  const [visible, setVisible] = React.useState(false);
  const [capsLock, setCapsLock] = React.useState(false);
  const Icon = visible ? EyeOff : Eye;

  function syncCapsLock(e: React.KeyboardEvent<HTMLInputElement>) {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Input
          type={visible ? "text" : "password"}
          disabled={disabled}
          className={cn("pr-9", className)}
          onKeyUp={(e) => {
            syncCapsLock(e);
            onKeyUp?.(e);
          }}
          onKeyDown={(e) => {
            syncCapsLock(e);
            onKeyDown?.(e);
          }}
          onBlur={(e) => {
            setCapsLock(false);
            onBlur?.(e);
          }}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? t("hidePassword") : t("showPassword")}
          aria-pressed={visible}
          tabIndex={-1}
          className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      </div>
      {capsLock && (
        <p
          role="status"
          className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500"
        >
          <ArrowBigUp className="size-3.5" aria-hidden="true" />
          {t("capsLockOn")}
        </p>
      )}
    </div>
  );
}

export { PasswordInput };
