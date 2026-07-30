"use client";

import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import { backendService } from "@/lib/services";
import { MockTimeApi } from "./mock-time-api";
import { MockTimeLegacy } from "./mock-time-legacy";

export function MockTime({
  environment,
}: {
  environment: SafeEnvironmentWithServers;
}) {
  const isLegacy = !backendService(environment).mockTimeApiUrl?.trim();
  if (isLegacy) return <MockTimeLegacy environment={environment} />;
  return <MockTimeApi environment={environment} />;
}
