import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
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
import { domainErrorCode } from "@/lib/domains/errors";
import { originHostSchema } from "@/lib/domains/validation";
import { ApiError } from "@/web/api/client";
import { registerRemoteTunnel } from "@/web/api/remote-tunnels";
import { getServersQuery } from "@/web/api/servers";

export function remoteTunnelErrorText(
  error: ApiError,
  t: (key: string) => string
): string {
  const code = domainErrorCode(error.message);
  return code ? t(`errors.${code}`) : error.message;
}

export function RemoteTunnelRegisterDialog({
  open,
  onOpenChange,
  tunnel,
  takenServerIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tunnel: { id: string; name: string };
  takenServerIds: string[];
}) {
  const t = useTranslations("cloudflareAccount");
  const tDomains = useTranslations("domains");
  const tCommon = useTranslations("common");
  const servers = useQuery({ ...getServersQuery(), enabled: open });
  const [serverId, setServerId] = React.useState("");
  const [originHost, setOriginHost] = React.useState("localhost");
  const [submitting, setSubmitting] = React.useState(false);

  // Reset on every open so a reopened dialog doesn't show stale values.
  React.useEffect(() => {
    if (open) {
      setServerId("");
      setOriginHost("localhost");
    }
  }, [open]);

  const originValid = originHostSchema.safeParse(originHost).success;
  const available = (servers.data ?? []).filter(
    (s) => !takenServerIds.includes(s.id)
  );

  async function onSubmit() {
    setSubmitting(true);
    try {
      await registerRemoteTunnel({
        serverId,
        tunnelId: tunnel.id,
        originHost: originHost.trim(),
      });
      toast.success(t("registered"));
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(remoteTunnelErrorText(error, tDomains));
        return;
      }
      throw error;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("registerTitle")}</DialogTitle>
          <DialogDescription>
            {t("registerDescription", { tunnel: tunnel.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>{t("server")}</Label>
            <Select
              value={serverId || undefined}
              onValueChange={(value) => setServerId(value ?? "")}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("serverPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {available.map((server) => (
                  <SelectItem key={server.id} value={server.id}>
                    {server.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="origin-host">{t("originHost")}</Label>
            <Input
              id="origin-host"
              className="font-mono"
              autoComplete="off"
              value={originHost}
              onChange={(e) => setOriginHost(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              {t("originHostDescription")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={!(serverId && originValid) || submitting}
          >
            {submitting ? t("registering") : t("register")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
