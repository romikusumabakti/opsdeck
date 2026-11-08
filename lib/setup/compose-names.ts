import type {
  EnvironmentSetupTarget,
  SetupServiceRole,
} from "@/lib/setup/schema";

// Docker Compose container names, as the setup suggests them for service
// control and logs. Pure, shared by the setup service and the new-environment
// resolver.

/**
 * The container name Docker Compose gives service `svc` of the project in
 * `deployDir`: the service's `container_name` when it fixes one, else
 * `<project>-<svc>-1`. The project is the compose file's top-level `name:`
 * when it has one, else the directory's base name; lowercased, without
 * characters Compose drops.
 */
export function composeContainerName(
  deployDir: string,
  svc: string,
  detected?: { projectName?: string | null; containerName?: string | null }
): string {
  if (detected?.containerName) return detected.containerName;
  const project = (
    detected?.projectName ??
    deployDir.split("/").filter(Boolean).at(-1) ??
    ""
  )
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return `${project}-${svc}-1`;
}

/**
 * Suggested service bindings: the entry service (else the last one) as
 * frontend, then the first other compose service as backend and the next as
 * worker; further services get no row. A lone service is the backend (the
 * environment model always has one). Each name is the Compose default
 * container name; for a role whose source row names a fixed container
 * (`container_name`, not the source's own Compose default), that name is
 * suggested unchanged so the in-use check reports it. `detected` carries the
 * repository's compose `name:` and per-service `container_name`s.
 */
export function suggestServices(
  targets: readonly Pick<EnvironmentSetupTarget, "deployDir" | "services">[],
  entryService: string | null | undefined,
  source?: {
    rows: readonly { role: string; serviceName: string }[];
    targets: readonly { deployDir: string; services: readonly string[] }[];
  } | null,
  detected?: {
    projectName?: string | null;
    containerNames?: Readonly<Record<string, string | null>>;
  }
): { role: SetupServiceRole; serviceName: string }[] {
  const naming = (svc: string) => ({
    projectName: detected?.projectName,
    containerName: detected?.containerNames?.[svc],
  });
  const all = targets.flatMap((t) =>
    t.services.map((svc) => ({ svc, deployDir: t.deployDir }))
  );
  const unique = all.filter(
    (entry, i) => all.findIndex((e) => e.svc === entry.svc) === i
  );
  if (unique.length === 0) return [];
  const roles: { role: SetupServiceRole; entry: (typeof unique)[number] }[] =
    [];
  if (unique.length === 1) {
    roles.push({
      role: "backend",
      entry: unique[0] as (typeof unique)[number],
    });
  } else {
    const entry =
      unique.find((e) => e.svc === entryService) ??
      (unique.at(-1) as (typeof unique)[number]);
    roles.push({ role: "frontend", entry });
    const others = unique.filter((e) => e !== entry);
    const [backend, worker] = others;
    if (backend) roles.push({ role: "backend", entry: backend });
    if (worker) roles.push({ role: "worker", entry: worker });
  }
  const sourceDefaults = new Set(
    (source?.targets ?? []).flatMap((t) =>
      t.services.map((svc) =>
        composeContainerName(t.deployDir, svc, naming(svc))
      )
    )
  );
  return roles.map(({ role, entry }) => {
    const fixed = source?.rows.find(
      (r) => r.role === role && !sourceDefaults.has(r.serviceName)
    );
    return {
      role,
      serviceName:
        fixed?.serviceName ??
        composeContainerName(entry.deployDir, entry.svc, naming(entry.svc)),
    };
  });
}
