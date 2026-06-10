"use client";

import type { SafeProjectWithServers } from "@/lib/db/schema";
import { MockTimeApi } from "./mock-time-api";
import { MockTimeLegacy } from "./mock-time-legacy";

export function MockTime({ project }: { project: SafeProjectWithServers }) {
  const isLegacy = !project.backendMockTimeApiUrl?.trim();
  if (isLegacy) return <MockTimeLegacy project={project} />;
  return <MockTimeApi project={project} />;
}
