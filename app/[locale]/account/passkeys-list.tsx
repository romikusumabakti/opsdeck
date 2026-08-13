"use client";

import { Fingerprint, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  authClient,
  isPasskeySupported,
  useListPasskeys,
} from "@/lib/auth-client";

/**
 * Codes a passkey ceremony reports when the user dismissed the browser sheet.
 * Cancelling is not a failure, so it raises no toast.
 */
const CANCELLED_CODES = new Set(["AUTH_CANCELLED", "ERROR_CEREMONY_ABORTED"]);

export function PasskeysList() {
  const t = useTranslations("account.passkeys");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const dialog = useDialog();

  const { data: passkeys, isPending, refetch } = useListPasskeys();
  const [adding, setAdding] = React.useState(false);
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  // Resolved after mount — the server cannot know whether this browser does
  // WebAuthn, and a button that renders then vanishes is worse than one that
  // appears a frame late.
  const [supported, setSupported] = React.useState(false);
  React.useEffect(() => {
    setSupported(isPasskeySupported());
  }, []);

  async function onAdd() {
    // Named up front rather than afterwards: if the ceremony is cancelled there
    // is no half-registered row to clean up, and the list never shows an
    // unlabelled entry the user has to go back and identify.
    const name = await dialog.prompt({
      title: t("addTitle"),
      description: t("addDescription"),
      defaultValue: t("defaultName"),
      placeholder: t("namePlaceholder"),
      confirmText: t("add"),
      cancelText: tCommon("cancel"),
    });
    if (name === null) return;

    setAdding(true);
    const { error } = await authClient.passkey.addPasskey({
      name: name.trim() || undefined,
    });
    setAdding(false);

    if (error) {
      const code = "code" in error ? error.code : undefined;
      if (code && CANCELLED_CODES.has(code)) return;
      // Registration needs a recent sign-in (better-auth's fresh-session rule),
      // so a session older than a day lands here rather than on a raw message.
      toast.error(
        code === "SESSION_NOT_FRESH"
          ? t("errorNotFresh")
          : (error.message ?? tCommon("errorGeneric"))
      );
      return;
    }

    toast.success(t("addedSuccess"));
    refetch();
  }

  async function onRename(passkey: { id: string; name?: string | null }) {
    const name = await dialog.prompt({
      title: t("renameTitle"),
      description: t("renameDescription"),
      defaultValue: passkey.name ?? "",
      placeholder: t("namePlaceholder"),
      confirmText: tCommon("save"),
      cancelText: tCommon("cancel"),
    });
    if (name === null || !name.trim()) return;

    setPendingId(passkey.id);
    const { error } = await authClient.passkey.updatePasskey({
      id: passkey.id,
      name: name.trim(),
    });
    setPendingId(null);

    if (error) {
      toast.error(error.message ?? tCommon("errorGeneric"));
      return;
    }
    toast.success(t("renamedSuccess"));
    refetch();
  }

  async function onDelete(passkey: { id: string }) {
    const ok = await dialog.confirm({
      title: t("deleteTitle"),
      description: t("deleteDescription"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;

    setPendingId(passkey.id);
    const { error } = await authClient.passkey.deletePasskey({
      id: passkey.id,
    });
    setPendingId(null);

    if (error) {
      toast.error(error.message ?? tCommon("errorGeneric"));
      return;
    }
    toast.success(t("deletedSuccess"));
    refetch();
  }

  if (!supported) {
    return (
      <EmptyState
        icon={Fingerprint}
        title={t("unsupportedTitle")}
        description={t("unsupportedDescription")}
      />
    );
  }

  if (isPending) {
    return (
      <div className="py-10 flex items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const items = passkeys ?? [];

  return (
    <div className="flex flex-col gap-4">
      {items.length === 0 ? (
        <EmptyState
          icon={Fingerprint}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
        />
      ) : (
        <ul className="divide-y">
          {items.map((passkey) => (
            <li
              key={passkey.id}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Fingerprint className="size-4 text-muted-foreground" />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">
                      {passkey.name || t("unnamed")}
                    </span>
                    {passkey.backedUp && (
                      <Badge variant="secondary" className="text-xs">
                        {t("synced")}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("addedAt", {
                      date: format.dateTime(new Date(passkey.createdAt), {
                        dateStyle: "medium",
                      }),
                    })}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRename(passkey)}
                  disabled={pendingId === passkey.id}
                  aria-label={t("rename")}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(passkey)}
                  disabled={pendingId === passkey.id}
                  aria-label={tCommon("delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          onClick={onAdd}
          disabled={adding}
          aria-busy={adding}
        >
          {adding ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="size-4" aria-hidden="true" />
          )}
          {t("add")}
        </Button>
      </div>
    </div>
  );
}
