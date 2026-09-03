"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { attachTunnelNetwork, createTunnelRoute } from "@/actions/tunnels";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TunnelWithContext } from "@/lib/db/schema";
import type { ContainerInfo } from "@/lib/tunnels/remote";

type Candidate = ContainerInfo & { reachable: boolean };

// One flat DNS label. Mirrors subdomainLabelSchema on the server — kept here as
// well so the operator sees the rule while typing rather than after submitting.
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function TunnelRouteDialog({
  open,
  onOpenChange,
  tunnel,
  candidates,
  existing,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tunnel: TunnelWithContext;
  candidates: Candidate[];
  existing: string[];
  onDone: () => void;
}) {
  const t = useTranslations("tunnels");
  const tCommon = useTranslations("common");
  const [label, setLabel] = React.useState("");
  const [originHost, setOriginHost] = React.useState("");
  const [originPort, setOriginPort] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [attaching, setAttaching] = React.useState(false);

  const selected = candidates.find((c) => c.name === originHost);

  // Reset on every open so a dialog reopened after a failure doesn't present
  // stale values as if they had been saved.
  React.useEffect(() => {
    if (open) {
      setLabel("");
      setOriginHost("");
      setOriginPort("");
    }
  }, [open]);

  // Pre-fill the port when the chosen container declares exactly one: that is
  // the overwhelmingly common case, and typing it again invites a typo.
  React.useEffect(() => {
    if (selected?.ports.length === 1) setOriginPort(String(selected.ports[0]));
  }, [selected]);

  const hostname = label ? `${label}.${tunnel.zone.name}` : "";
  const labelValid = LABEL_PATTERN.test(label);
  const duplicate = existing.includes(hostname);
  const portValue = Number(originPort);
  const portValid =
    Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535;

  const canSubmit =
    labelValid &&
    !duplicate &&
    originHost.length > 0 &&
    portValid &&
    !submitting;

  // Attaching recreates the tunnel container, so the candidate list this dialog
  // was handed goes stale — `onDone` refreshes the page behind it and the dialog
  // closes rather than showing a warning that is no longer true.
  async function onAttach(network: string) {
    setAttaching(true);
    try {
      const result = await attachTunnelNetwork({
        tunnelId: tunnel.id,
        network,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      onOpenChange(false);
      onDone();
    } finally {
      setAttaching(false);
    }
  }

  async function onSubmit() {
    setSubmitting(true);
    try {
      const result = await createTunnelRoute({
        tunnelId: tunnel.id,
        label,
        originHost,
        originPort: portValue,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message ?? "");
      onOpenChange(false);
      onDone();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("addHostname")}</DialogTitle>
          <DialogDescription>
            {t("addHostnameDescription", { tunnel: tunnel.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="tunnel-route-label">{t("fieldLabel")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="tunnel-route-label"
                value={label}
                autoComplete="off"
                spellCheck={false}
                placeholder="dapenmu-foo"
                onChange={(e) => setLabel(e.target.value.trim().toLowerCase())}
              />
              <span className="text-sm text-muted-foreground font-mono shrink-0">
                .{tunnel.zone.name}
              </span>
            </div>
            {/* Not a style rule: Cloudflare's free Universal SSL covers exactly
                one level under the zone, so a dotted name would be served a
                certificate that doesn't match it. */}
            <p className="text-xs text-muted-foreground">
              {t("fieldLabelHint")}
            </p>
            {label.length > 0 && !labelValid && (
              <p className="text-xs text-destructive">{t("labelInvalid")}</p>
            )}
            {duplicate && (
              <p className="text-xs text-destructive">
                {t("labelDuplicate", { hostname })}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tunnel-route-origin">{t("fieldOrigin")}</Label>
            <Select
              value={originHost}
              onValueChange={(value) => setOriginHost(value ?? "")}
            >
              <SelectTrigger id="tunnel-route-origin">
                <SelectValue placeholder={t("fieldOriginPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    <span className="font-mono">{c.name}</span>
                    {c.state !== "running" && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t("originStopped")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("fieldOriginHint")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tunnel-route-port">{t("fieldPort")}</Label>
            {selected && selected.ports.length > 1 ? (
              <Select
                value={originPort}
                onValueChange={(value) => setOriginPort(value ?? "")}
              >
                <SelectTrigger id="tunnel-route-port">
                  <SelectValue placeholder={t("fieldPortPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {selected.ports.map((port) => (
                    <SelectItem key={port} value={String(port)}>
                      {port}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="tunnel-route-port"
                inputMode="numeric"
                value={originPort}
                placeholder="80"
                onChange={(e) =>
                  setOriginPort(e.target.value.replace(/\D/g, ""))
                }
              />
            )}
            <p className="text-xs text-muted-foreground">
              {t("fieldPortHint")}
            </p>
          </div>

          {selected && !selected.reachable && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertDescription className="flex flex-col items-start gap-2">
                {t("originUnreachableWarning", {
                  container: tunnel.containerName,
                  origin: selected.name,
                })}
                {/* The fix is offered here as well as on the ingress table,
                    because a brand-new application hits this before it has a
                    route to offer the action from — the common case, since
                    every new app stack brings a network of its own. */}
                {selected.networks[0] && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={attaching}
                    onClick={() => onAttach(selected.networks[0] as string)}
                  >
                    {attaching && <Loader2 className="size-4 animate-spin" />}
                    {t("attachNetwork")}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {selected?.state !== "running" && selected && (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertDescription>
                {t("originStoppedWarning", { origin: selected.name })}
              </AlertDescription>
            </Alert>
          )}

          {hostname && labelValid && (
            <p className="text-sm">
              {t("addHostnamePreview")}{" "}
              <span className="font-mono font-medium">{hostname}</span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {tCommon("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {submitting ? t("publishing") : t("publish")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
