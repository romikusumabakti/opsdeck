// Planned deploy history for the demo targets over the 30 days before `now`:
// CI builds per component and branch, and the deployments of those builds.
// Pure and deterministic (seeded by stable strings), so the seed and the tests
// plan the same rows. Every deployment ends in a terminal status: the worker
// sweeps queued/running rows, and nothing would ever finish them.
import {
  appByKey,
  DEMO_ENVIRONMENTS,
  DEMO_PROJECTS,
  type DemoAppKey,
  type DemoComponent,
  type DemoEnvironmentSlug,
  type DemoProject,
  targetBranch,
  targetDeployDir,
} from "./catalog";
import type { PersonRef } from "./issues";
import { DEMO_STAFF } from "./people";
import {
  addDays,
  addMinutes,
  addSeconds,
  between,
  fakeSha,
  prng,
  workTime,
} from "./random";

export interface PlannedTarget {
  project: DemoProject;
  slug: DemoEnvironmentSlug;
  component: DemoComponent;
  branch: string;
  deployDir: string;
}

export interface PlannedBuild {
  componentKey: string;
  branch: string;
  tag: string;
  commitSha: string;
  commitMessage: string;
  pushedBy: string;
  commitAuthorEmail: string;
  pipelineUrl: string;
  receivedAt: Date;
}

export interface PlannedDeployment {
  projectKey: string;
  slug: DemoEnvironmentSlug;
  componentKey: string;
  buildTag: string;
  trigger: "manual" | "rollback";
  status: "success" | "failed";
  actor: PersonRef;
  createdAt: Date;
  startedAt: Date;
  scriptStartedAt: Date;
  finishedAt: Date;
  output: string;
  errorMessage: string | null;
  // Failed runs older than a few days were looked at.
  acknowledged: boolean;
}

// Who pushes to each app's repositories.
const PUSHERS: Record<DemoAppKey, readonly PersonRef[]> = {
  "demo-membership": ["ayu", "bima", "fajar"],
  "demo-portal": ["ayu", "dimas", "hadi"],
  "demo-accounting": ["bima", "hadi", "fajar"],
};

// Who presses Deploy in each project (members with deploy rights).
const DEPLOYERS: Record<string, readonly PersonRef[]> = {
  DEMO: ["demo-engineer"],
  DEMOPORTAL: ["demo-engineer"],
  NPMB: ["ayu", "bima", "fajar"],
  NPCP: ["dimas", "hadi", "fajar"],
  BSAC: ["bima", "hadi", "joko"],
};

const COMMIT_MESSAGES: Record<DemoComponent["service"], readonly string[]> = {
  backend: [
    "fix: round contribution totals per member",
    "feat: pension benefit simulation endpoint",
    "fix: reject empty birth dates on member import",
    "perf: paginate contribution history",
    "feat: audit log for bank account changes",
    "chore: bump dependencies",
    "fix: recalculate balance after contribution correction",
    "feat: supervisor approval for member data changes",
    "refactor: split report queries from daily transactions",
    "fix: retry OTP e-mail when the queue is full",
  ],
  frontend: [
    "fix: card layout for statements on small screens",
    "feat: claim form wizard",
    "fix: download member card without a popup",
    "feat: balance growth chart",
    "chore: update translations",
    "fix: keep the session alive while typing in forms",
    "feat: claim status timeline",
    "style: align dashboard tiles",
  ],
};

const FAILURES = [
  {
    line: "Health check failed: no healthy response within 180s",
    error: "Health check timed out after 180s",
  },
  {
    line: "docker compose pull failed: manifest unknown",
    error: "Image pull failed",
  },
  {
    line: "Pre-start command exited with status 1 (migration lock held)",
    error: "Pre-start command failed",
  },
] as const;

const staffLogin = (ref: PersonRef): string =>
  DEMO_STAFF.find((s) => s.handle === ref)?.login ?? ref;

/** Every (project, environment, component) target the demo projects have. */
export function plannedTargets(): PlannedTarget[] {
  return DEMO_PROJECTS.flatMap((project) =>
    DEMO_ENVIRONMENTS.flatMap((env) =>
      appByKey(project.app).components.map((component) => ({
        project,
        slug: env.slug,
        component,
        branch: targetBranch(project, env.slug),
        deployDir: targetDeployDir(project, env.slug, component),
      }))
    )
  );
}

/** CI builds for every component and branch some target deploys. */
export function planBuilds(now: Date, emailDomain: string): PlannedBuild[] {
  const builds: PlannedBuild[] = [];
  const pairs = new Map<
    string,
    { appKey: DemoAppKey; component: DemoComponent; branch: string }
  >();
  for (const target of plannedTargets()) {
    pairs.set(`${target.component.componentKey} ${target.branch}`, {
      appKey: target.project.app,
      component: target.component,
      branch: target.branch,
    });
  }
  const byComponent = new Map<string, PlannedBuild[]>();
  for (const [seed, { appKey, component, branch }] of pairs) {
    const next = prng(`builds ${seed}`);
    const count = branch === "develop" ? 6 : 4;
    const messages = COMMIT_MESSAGES[component.service];
    const pushers = PUSHERS[appKey];
    for (let i = 0; i < count; i++) {
      // Oldest first, spread over days 29..1 before `now`.
      const daysAgo = Math.max(
        1,
        Math.round(29 - (i * 28) / (count - 1)) - between(next, 0, 1)
      );
      const pusher = pushers[between(next, 0, pushers.length - 1)] ?? "ayu";
      const login = staffLogin(pusher);
      const list = byComponent.get(component.componentKey) ?? [];
      list.push({
        componentKey: component.componentKey,
        branch,
        tag: "",
        commitSha: fakeSha(`${seed} ${i}`),
        commitMessage: messages[between(next, 0, messages.length - 1)] ?? "",
        pushedBy: login,
        commitAuthorEmail: `${login}@${emailDomain}`,
        pipelineUrl: "",
        receivedAt: workTime(now, daysAgo, between(next, 30, 420)),
      });
      byComponent.set(component.componentKey, list);
    }
  }
  // Tags count up per component in build order, like a CI build number.
  for (const [componentKey, list] of byComponent) {
    const component = plannedTargets().find(
      (t) => t.component.componentKey === componentKey
    )?.component;
    list.sort(
      (a, b) =>
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        a.commitSha.localeCompare(b.commitSha)
    );
    list.forEach((build, index) => {
      const number = 100 + index + 1;
      build.tag = `${component?.version ?? "1.0.0"}-${number}`;
      build.pipelineUrl = `https://ci.example.invalid/repos/demo/pipeline/${number}`;
    });
    builds.push(...list);
  }
  return builds;
}

const runLine = (at: Date, line: string) => `[${at.toISOString()}] ${line}\n`;

/** The deployments of each target, oldest first. */
export function planDeployments(
  now: Date,
  builds: readonly PlannedBuild[],
  targets: readonly PlannedTarget[],
  server: (project: DemoProject) => string
): PlannedDeployment[] {
  const out: PlannedDeployment[] = [];
  // Failures older than this were acknowledged; newer ones still show under
  // "Needs attention".
  const ackBefore = addDays(now, -5);
  for (const target of targets) {
    const key = `${target.project.key} ${target.slug} ${target.component.componentKey}`;
    const next = prng(`deploys ${key}`);
    const chance = { dev: 1, qa: 0.75, demo: 0.5 }[target.slug];
    const deployers = DEPLOYERS[target.project.key] ?? ["demo-engineer"];
    const mine = builds.filter(
      (b) =>
        b.componentKey === target.component.componentKey &&
        b.branch === target.branch
    );
    let lastSuccess: PlannedBuild | null = null;
    mine.forEach((build, index) => {
      const last = index === mine.length - 1;
      if (index > 0 && !last && next() > chance) return;
      const actor = deployers[between(next, 0, deployers.length - 1)] ?? "ayu";
      // The newest build always lands, so every environment ends healthy
      // unless a rollback is the last word.
      const failed = !last && next() < 0.15;
      const createdAt = addMinutes(build.receivedAt, between(next, 5, 90));
      out.push(
        deployment(
          target,
          build,
          "manual",
          failed,
          actor,
          createdAt,
          next,
          server,
          ackBefore
        )
      );
      if (failed && lastSuccess) {
        out.push(
          deployment(
            target,
            lastSuccess,
            "rollback",
            false,
            actor,
            addMinutes(createdAt, between(next, 10, 25)),
            next,
            server,
            ackBefore
          )
        );
      }
      if (!failed) lastSuccess = build;
    });
  }
  return out;
}

function deployment(
  target: PlannedTarget,
  build: PlannedBuild,
  trigger: "manual" | "rollback",
  failed: boolean,
  actor: PersonRef,
  createdAt: Date,
  next: () => number,
  server: (project: DemoProject) => string,
  ackBefore: Date
): PlannedDeployment {
  const startedAt = addSeconds(createdAt, between(next, 2, 8));
  const scriptStartedAt = addSeconds(startedAt, between(next, 3, 10));
  const finishedAt = addSeconds(scriptStartedAt, between(next, 40, 220));
  const failure =
    FAILURES[between(next, 0, FAILURES.length - 1)] ?? FAILURES[0];
  const { componentKey, bundleImage, service } = target.component;
  const output = [
    runLine(
      startedAt,
      `Deploying ${componentKey} ${build.tag} to ${server(target.project)}:${target.deployDir} (demo data, nothing ran)`
    ),
    runLine(addSeconds(startedAt, 2), `Pulling ${bundleImage}:${build.tag}`),
    runLine(scriptStartedAt, `docker compose up -d ${service}`),
    runLine(
      finishedAt,
      failed ? failure.line : `Health check passed; ${build.tag} is live`
    ),
  ].join("");
  return {
    projectKey: target.project.key,
    slug: target.slug,
    componentKey,
    buildTag: build.tag,
    trigger,
    status: failed ? "failed" : "success",
    actor,
    createdAt,
    startedAt,
    scriptStartedAt,
    finishedAt,
    output,
    errorMessage: failed ? failure.error : null,
    acknowledged: failed && finishedAt.getTime() < ackBefore.getTime(),
  };
}
