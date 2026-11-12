import type * as React from "react";
import { useTranslations } from "use-intl";
import type { ProvisioningStepSpec } from "@/lib/provisioning/plan";

/** What the sentences name; any lookup may miss, then the id is shown. */
export type ProvisioningLookups = {
  serverLabel: (serverId: string) => string | undefined;
  databaseHost: (
    id: string
  ) => { label: string; containerName: string; serverId: string } | undefined;
  componentKey: (targetId: string) => string | undefined;
  tunnelName: (remoteTunnelId: string) => string | undefined;
  policyName: (policyId: string) => string | undefined;
};

const code = (chunks: React.ReactNode) => (
  <code className="font-mono text-sm">{chunks}</code>
);

/** The human sentence of a step. Names fall back to ids when a lookup misses. */
export function StepSentence({
  spec,
  lookups,
}: {
  spec: ProvisioningStepSpec;
  lookups: ProvisioningLookups;
}) {
  const t = useTranslations("provisioning");
  switch (spec.kind) {
    case "prepare_deploy_dir":
      return t.rich("step.prepare_deploy_dir", {
        code,
        dir: spec.params.deployDir,
        server:
          lookups.serverLabel(spec.params.serverId) ?? spec.params.serverId,
      });
    case "create_database": {
      const host = lookups.databaseHost(spec.params.databaseHostId);
      const server = host ? lookups.serverLabel(host.serverId) : undefined;
      return t.rich(
        server ? "step.create_database" : "step.create_database_no_server",
        {
          code,
          database: spec.params.database,
          host: host?.containerName ?? spec.params.databaseHostId,
          server: server ?? "",
        }
      );
    }
    case "tunnel_route":
      return t.rich("step.tunnel_route", {
        code,
        hostname: spec.params.hostname,
        service: spec.params.service,
        tunnel:
          lookups.tunnelName(spec.params.remoteTunnelId) ??
          spec.params.remoteTunnelId,
      });
    case "access_app":
      return t.rich("step.access_app", {
        code,
        hostname: spec.params.hostname,
        policy:
          lookups.policyName(spec.params.policyId) ?? spec.params.policyId,
      });
    case "dns_record":
      return t.rich("step.dns_record", {
        code,
        hostname: spec.params.hostname,
      });
    case "deploy":
      return t.rich("step.deploy", {
        code,
        branch: spec.params.branch,
        component:
          lookups.componentKey(spec.params.targetId) ?? spec.params.targetId,
      });
  }
}
