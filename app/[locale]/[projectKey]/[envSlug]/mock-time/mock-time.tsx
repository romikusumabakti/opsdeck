"use client";

import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import { backendService } from "@/lib/services";
import { MockTimeApi } from "./mock-time-api";
import { MockTimeLegacy } from "./mock-time-legacy";

export function MockTime({ project }: { project: SafeEnvironmentWithServers }) {
  const isLegacy = !backendService(project).mockTimeApiUrl?.trim();
  if (isLegacy) return <MockTimeLegacy project={project} />;
  return <MockTimeApi project={project} />;
}
