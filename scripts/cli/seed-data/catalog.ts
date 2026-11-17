// Demo catalog: projects, environments, placeholder servers, apps and their
// components. Pure data; every name is fictional and every host is .invalid.

export const DEMO_SERVERS = [
  "sandbox-1.invalid",
  "sandbox-2.invalid",
  "sandbox-3.invalid",
] as const;
export type DemoServerHost = (typeof DEMO_SERVERS)[number];

export interface DemoProject {
  key: string;
  name: string;
  client: string;
  description: string;
  app: DemoAppKey;
  defaultServer: DemoServerHost;
  // Default branch of every component of the project's app (QA and Demo
  // environments deploy it; Dev deploys DEV_BRANCH).
  branch: string;
}

export const DEV_BRANCH = "develop";

export const DEMO_PROJECTS: readonly DemoProject[] = [
  {
    key: "DEMO",
    name: "Demo Membership",
    client: "Demo",
    description: "Sample membership project for trying Menara.",
    app: "demo-membership",
    defaultServer: "sandbox-1.invalid",
    branch: "release/demo",
  },
  {
    key: "DEMOPORTAL",
    name: "Demo Portal",
    client: "Demo",
    description: "Sample customer portal project for trying Menara.",
    app: "demo-portal",
    defaultServer: "sandbox-2.invalid",
    branch: "release/demo",
  },
  {
    key: "NPMB",
    name: "Nusantara Pensiun Membership",
    client: "DPLK Nusantara Pensiun",
    description:
      "Kepesertaan, iuran dan manfaat pensiun untuk DPLK Nusantara Pensiun (fiktif).",
    app: "demo-membership",
    defaultServer: "sandbox-1.invalid",
    branch: "release/nusantara",
  },
  {
    key: "NPCP",
    name: "Nusantara Pensiun Portal",
    client: "DPLK Nusantara Pensiun",
    description:
      "Portal peserta DPLK Nusantara Pensiun: saldo, iuran, klaim (fiktif).",
    app: "demo-portal",
    defaultServer: "sandbox-2.invalid",
    branch: "release/nusantara",
  },
  {
    key: "BSAC",
    name: "Bahari Sejahtera Accounting",
    client: "Dana Pensiun Bahari Sejahtera",
    description:
      "Akuntansi dan pelaporan Dana Pensiun Bahari Sejahtera (fiktif).",
    app: "demo-accounting",
    defaultServer: "sandbox-3.invalid",
    branch: "release/bahari",
  },
];

// `kind` has no "demo" value: a client demo runs a release branch, so it is
// a `release` environment.
export const DEMO_ENVIRONMENTS = [
  { name: "Dev", slug: "dev", kind: "dev" },
  { name: "QA", slug: "qa", kind: "qa" },
  { name: "Demo", slug: "demo", kind: "release" },
] as const;
export type DemoEnvironmentSlug = (typeof DEMO_ENVIRONMENTS)[number]["slug"];

// A CI connection is required by app_components; this one points nowhere and
// holds no tokens, so nothing ever calls it.
export const DEMO_CI_CONNECTION = {
  name: "Demo CI (placeholder)",
  provider: "woodpecker",
  forge: "gitea",
  baseUrl: "https://ci.example.invalid",
} as const;

export type DemoAppKey = "demo-membership" | "demo-portal" | "demo-accounting";

export interface DemoComponent {
  componentKey: string;
  repoFullName: string;
  bundleImage: string;
  // The compose service the target restarts.
  service: "backend" | "frontend";
  // Tags are `<version>-<n>`.
  version: string;
}

export interface DemoApp {
  appKey: DemoAppKey;
  name: string;
  components: readonly DemoComponent[];
}

export const DEMO_APPS: readonly DemoApp[] = [
  {
    appKey: "demo-membership",
    name: "Demo Membership",
    components: [
      {
        componentKey: "demo-membership-backend",
        repoFullName: "demo-org/membership-backend",
        bundleImage: "demo-membership-backend-deploy",
        service: "backend",
        version: "1.4.0",
      },
      {
        componentKey: "demo-membership-frontend",
        repoFullName: "demo-org/membership-frontend",
        bundleImage: "demo-membership-frontend-deploy",
        service: "frontend",
        version: "1.4.0",
      },
    ],
  },
  {
    appKey: "demo-portal",
    name: "Demo Portal",
    components: [
      {
        componentKey: "demo-portal-backend",
        repoFullName: "demo-org/portal-backend",
        bundleImage: "demo-portal-backend-deploy",
        service: "backend",
        version: "2.1.0",
      },
      {
        componentKey: "demo-portal-frontend",
        repoFullName: "demo-org/portal-frontend",
        bundleImage: "demo-portal-frontend-deploy",
        service: "frontend",
        version: "2.1.0",
      },
    ],
  },
  {
    appKey: "demo-accounting",
    name: "Demo Accounting",
    components: [
      {
        componentKey: "demo-accounting-backend",
        repoFullName: "demo-org/accounting-backend",
        bundleImage: "demo-accounting-backend-deploy",
        service: "backend",
        version: "0.9.0",
      },
    ],
  },
];

export const appByKey = (key: DemoAppKey): DemoApp => {
  const app = DEMO_APPS.find((a) => a.appKey === key);
  if (!app) throw new Error(`Unknown demo app ${key}`);
  return app;
};

/** The branch a project's target in an environment deploys. */
export const targetBranch = (
  project: DemoProject,
  slug: DemoEnvironmentSlug
): string => (slug === "dev" ? DEV_BRANCH : project.branch);

/** Where a target's bundle lives on its (placeholder) server. */
export const targetDeployDir = (
  project: DemoProject,
  slug: DemoEnvironmentSlug,
  component: DemoComponent
): string =>
  `/srv/demo/${project.key.toLowerCase()}-${slug}/${component.service}`;

/** The placeholder URL an environment opens at. */
export const environmentUrl = (
  project: DemoProject,
  slug: DemoEnvironmentSlug
): string => `https://${project.key.toLowerCase()}-${slug}.example.invalid`;
