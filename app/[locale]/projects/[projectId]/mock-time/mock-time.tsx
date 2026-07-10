"use client";

import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import { MockTimeApi } from "./mock-time-api";
import { MockTimeLegacy } from "./mock-time-legacy";

export function MockTime({ project }: { project: SafeEnvironmentWithServers }) {
  const isLegacy = !project.backendMockTimeApiUrl?.trim();
  if (isLegacy) return <MockTimeLegacy project={project} />;
  return <MockTimeApi project={project} />;
}
