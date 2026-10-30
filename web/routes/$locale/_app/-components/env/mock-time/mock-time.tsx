import { backendService } from "@/lib/services";
import type { EnvironmentWithServers } from "@/web/api/environments";
import { MockTimeApi } from "./mock-time-api";
import { MockTimeLegacy } from "./mock-time-legacy";

export function MockTime({
  environment,
}: {
  environment: EnvironmentWithServers;
}) {
  const isLegacy = !backendService(environment).mockTimeApiUrl?.trim();
  if (isLegacy) return <MockTimeLegacy environment={environment} />;
  return <MockTimeApi environment={environment} />;
}
